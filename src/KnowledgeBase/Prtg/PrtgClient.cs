using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace KnowledgeBase.Prtg;

/// <summary>
/// Thin, typed wrapper over the PRTG HTTP API.
/// <para>
/// Only the handful of calls the dashboard needs are exposed — there is
/// deliberately no generic passthrough, so the stored credentials can't be
/// used to reach arbitrary PRTG endpoints from the browser.
/// </para>
/// </summary>
public sealed class PrtgClient(
    HttpClient http,
    IOptions<PrtgOptions> options,
    IMemoryCache cache,
    ILogger<PrtgClient> log)
{
    private static readonly Regex HtmlTag = new("<[^>]+>", RegexOptions.Compiled);

    private readonly PrtgOptions _opt = options.Value;

    public bool IsConfigured => _opt.IsConfigured;

    private const string SensorColumns =
        "objid,device,sensor,type,group,probe,status,status_raw,lastvalue,lastvalue_raw," +
        "message,tags,parentid,priority";

    // ---------------------------------------------------------------- requests

    /// <summary>Appends the configured credentials to a PRTG API path.</summary>
    private string BuildUrl(string path, params (string Key, string? Value)[] query)
    {
        var baseUrl = _opt.BaseUrl.TrimEnd('/');
        var parts = new List<string>();

        foreach (var (key, value) in query)
        {
            if (value is null) continue;
            parts.Add($"{Uri.EscapeDataString(key)}={Uri.EscapeDataString(value)}");
        }

        if (_opt.HasToken)
        {
            parts.Add($"apitoken={Uri.EscapeDataString(_opt.ApiToken!)}");
        }
        else
        {
            parts.Add($"username={Uri.EscapeDataString(_opt.Username!)}");
            parts.Add($"passhash={Uri.EscapeDataString(_opt.PassHash!)}");
        }

        return $"{baseUrl}/{path.TrimStart('/')}?{string.Join("&", parts)}";
    }

    private async Task<JsonNode?> GetJsonAsync(
        string path,
        (string Key, string? Value)[] query,
        CancellationToken ct)
    {
        if (!_opt.IsConfigured)
            throw new PrtgNotConfiguredException();

        var url = BuildUrl(path, query);
        using var response = await http.GetAsync(url, ct);

        if (!response.IsSuccessStatusCode)
        {
            // Never echo the URL back — it carries the passhash.
            throw new PrtgApiException(
                $"PRTG returned {(int)response.StatusCode} {response.ReasonPhrase} for {path}.");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct);

        try
        {
            return await JsonNode.ParseAsync(stream, cancellationToken: ct);
        }
        catch (JsonException ex)
        {
            // A PRTG auth failure renders an HTML error page rather than JSON.
            throw new PrtgApiException(
                "PRTG did not return JSON. This usually means the API token or " +
                "username/passhash was rejected.", ex);
        }
    }

    /// <summary>Caches each distinct PRTG call for <see cref="PrtgOptions.CacheSeconds"/>.</summary>
    private Task<T> CachedAsync<T>(string key, Func<Task<T>> factory)
    {
        if (_opt.CacheSeconds <= 0) return factory();

        return cache.GetOrCreateAsync(
            $"prtg::{key}",
            entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(_opt.CacheSeconds);
                return factory();
            })!;
    }

    // ---------------------------------------------------------------- sensors

    /// <summary>
    /// The whole sensor table in one call. Every sensor view on the dashboard
    /// (alarms, flow, SNMP) partitions this list rather than re-querying PRTG.
    /// </summary>
    public Task<IReadOnlyList<PrtgSensor>> GetSensorsAsync(CancellationToken ct = default) =>
        CachedAsync<IReadOnlyList<PrtgSensor>>("sensors", async () =>
        {
            var json = await GetJsonAsync("api/table.json",
            [
                ("content", "sensors"),
                ("columns", SensorColumns),
                ("count", _opt.MaxSensors.ToString(CultureInfo.InvariantCulture)),
                ("sortby", "-status_raw"),
            ], ct);

            var rows = json?["sensors"]?.AsArray();
            if (rows is null) return Array.Empty<PrtgSensor>();

            var result = new List<PrtgSensor>(rows.Count);
            foreach (var row in rows)
            {
                if (row is null) continue;
                result.Add(new PrtgSensor
                {
                    Id = Int(row, "objid") ?? 0,
                    DeviceId = Int(row, "parentid") ?? 0,
                    Device = Str(row, "device"),
                    Sensor = Str(row, "sensor"),
                    Type = Str(row, "type"),
                    Group = Str(row, "group"),
                    Probe = Str(row, "probe"),
                    Status = Str(row, "status"),
                    StatusRaw = Int(row, "status_raw") ?? 0,
                    LastValue = StripHtml(Str(row, "lastvalue")),
                    LastValueRaw = Dbl(row, "lastvalue_raw"),
                    Message = StripHtml(Str(row, "message")),
                    Tags = Str(row, "tags"),
                    Priority = Int(row, "priority") ?? 0,
                });
            }

            return result;
        });

    // ----------------------------------------------------------------- status

    /// <summary>
    /// Core-server counters. Returns an unreachable status object instead of
    /// throwing, so one failing PRTG call can't blank the whole dashboard.
    /// </summary>
    public Task<PrtgServerStatus> GetServerStatusAsync(CancellationToken ct = default) =>
        CachedAsync("status", async () =>
        {
            try
            {
                var json = await GetJsonAsync("api/getstatus.json", [("id", "0")], ct);
                if (json is null)
                    return Unreachable("PRTG returned an empty status document.");

                return new PrtgServerStatus(
                    Version: NullIfEmpty(Str(json, "PRTGVersion")),
                    Alarms: IntLoose(json, "Alarms"),
                    AckAlarms: IntLoose(json, "AckAlarms"),
                    PartialAlarms: IntLoose(json, "PartialAlarms"),
                    UpSensors: IntLoose(json, "UpSens"),
                    WarningSensors: IntLoose(json, "WarnSens"),
                    DownSensors: IntLoose(json, "DownSens"),
                    PausedSensors: IntLoose(json, "PausedSens"),
                    UnknownSensors: IntLoose(json, "UnknownSens"),
                    NewMessages: IntLoose(json, "NewMessages"),
                    Reachable: true,
                    Error: null);
            }
            catch (PrtgNotConfiguredException)
            {
                throw;
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "PRTG status call failed.");
                return Unreachable(ex.Message);
            }
        });

    private static PrtgServerStatus Unreachable(string error) =>
        new(null, null, null, null, null, null, null, null, null, null, false, error);

    // ---------------------------------------------------------------- history

    /// <summary>
    /// Channel history for one sensor, used for the dashboard's traffic charts.
    /// </summary>
    /// <param name="hours">Window length, ending now.</param>
    /// <param name="averageSeconds">PRTG averaging interval; 0 means raw samples.</param>
    public Task<PrtgHistory> GetHistoryAsync(
        int sensorId,
        int hours,
        int averageSeconds,
        CancellationToken ct = default) =>
        CachedAsync($"history::{sensorId}::{hours}::{averageSeconds}", async () =>
        {
            var end = DateTime.Now;
            var start = end.AddHours(-Math.Clamp(hours, 1, 24 * 30));

            var json = await GetJsonAsync("api/historicdata.json",
            [
                ("id", sensorId.ToString(CultureInfo.InvariantCulture)),
                ("avg", averageSeconds.ToString(CultureInfo.InvariantCulture)),
                ("sdate", FormatPrtgDate(start)),
                ("edate", FormatPrtgDate(end)),
                ("usecaption", "1"),
            ], ct);

            var rows = json?["histdata"]?.AsArray();
            if (rows is null || rows.Count == 0)
                return new PrtgHistory(sensorId, [], Array.Empty<PrtgHistoryPoint>());

            // PRTG emits a formatted column plus a "<channel>(RAW)" numeric twin
            // when usecaption=1. Chart the RAW twins and label with the base name.
            var channels = new List<string>();
            foreach (var row in rows)
            {
                if (row is not JsonObject obj) continue;
                foreach (var kv in obj)
                {
                    if (!kv.Key.EndsWith("(RAW)", StringComparison.Ordinal)) continue;
                    var name = kv.Key[..^"(RAW)".Length].Trim();
                    if (name.Length > 0 && !channels.Contains(name)) channels.Add(name);
                }
                if (channels.Count > 0) break;
            }

            // Older cores (or sensors without raw twins) expose plain numeric columns.
            if (channels.Count == 0 && rows[0] is JsonObject first)
            {
                foreach (var kv in first)
                {
                    if (kv.Key.Equals("datetime", StringComparison.OrdinalIgnoreCase)) continue;
                    if (ToDouble(kv.Value) is not null) channels.Add(kv.Key);
                }
            }

            var points = new List<PrtgHistoryPoint>(rows.Count);
            foreach (var row in rows)
            {
                if (row is not JsonObject obj) continue;

                var values = new double?[channels.Count];
                for (var i = 0; i < channels.Count; i++)
                {
                    values[i] = ToDouble(obj[$"{channels[i]}(RAW)"]) ?? ToDouble(obj[channels[i]]);
                }

                var raw = Str(obj, "datetime");
                var (label, iso) = ParsePrtgTimestamp(raw);
                points.Add(new PrtgHistoryPoint(label, iso, values));
            }

            return new PrtgHistory(sensorId, [.. channels], points);
        });

    // --------------------------------------------------------------- toplists

    /// <summary>Toplists configured on a flow sensor (PRTG's top-talker tables).</summary>
    public Task<IReadOnlyList<PrtgToplist>> GetToplistsAsync(
        int sensorId,
        CancellationToken ct = default) =>
        CachedAsync<IReadOnlyList<PrtgToplist>>($"toplists::{sensorId}", async () =>
        {
            try
            {
                var json = await GetJsonAsync("api/table.json",
                [
                    ("content", "toplists"),
                    ("columns", "objid,name,type"),
                    ("id", sensorId.ToString(CultureInfo.InvariantCulture)),
                ], ct);

                var rows = json?["toplists"]?.AsArray();
                if (rows is null) return Array.Empty<PrtgToplist>();

                var list = new List<PrtgToplist>(rows.Count);
                foreach (var row in rows)
                {
                    if (row is null) continue;
                    list.Add(new PrtgToplist(
                        Int(row, "objid") ?? 0,
                        Str(row, "name"),
                        Str(row, "type")));
                }
                return list;
            }
            catch (PrtgNotConfiguredException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Toplist support varies by PRTG version and sensor type; an
                // empty list degrades the panel instead of failing the page.
                log.LogInformation(ex, "Toplist enumeration unavailable for sensor {SensorId}.", sensorId);
                return Array.Empty<PrtgToplist>();
            }
        });

    /// <summary>
    /// Rows of one toplist. Column names differ per toplist definition, so rows
    /// are returned as string dictionaries and the UI discovers the columns.
    /// </summary>
    public Task<IReadOnlyList<Dictionary<string, string>>> GetToplistDataAsync(
        int sensorId,
        int toplistId,
        CancellationToken ct = default) =>
        CachedAsync<IReadOnlyList<Dictionary<string, string>>>(
            $"toplistdata::{sensorId}::{toplistId}", async () =>
        {
            try
            {
                var json = await GetJsonAsync("api/toplistdata.json",
                [
                    ("id", sensorId.ToString(CultureInfo.InvariantCulture)),
                    ("tops", toplistId.ToString(CultureInfo.InvariantCulture)),
                ], ct);

                // The array's property name is not stable across versions —
                // take the first array of objects in the document.
                var rows = json as JsonArray;
                if (rows is null && json is JsonObject root)
                {
                    foreach (var kv in root)
                    {
                        if (kv.Value is JsonArray arr && arr.Count > 0 && arr[0] is JsonObject)
                        {
                            rows = arr;
                            break;
                        }
                    }
                }
                if (rows is null) return Array.Empty<Dictionary<string, string>>();

                var list = new List<Dictionary<string, string>>(rows.Count);
                foreach (var row in rows)
                {
                    if (row is not JsonObject obj) continue;
                    var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var kv in obj)
                    {
                        dict[kv.Key] = StripHtml(kv.Value?.ToString() ?? string.Empty);
                    }
                    if (dict.Count > 0) list.Add(dict);
                }
                return list;
            }
            catch (PrtgNotConfiguredException)
            {
                throw;
            }
            catch (Exception ex)
            {
                log.LogInformation(ex,
                    "Toplist data unavailable for sensor {SensorId} toplist {ToplistId}.",
                    sensorId, toplistId);
                return Array.Empty<Dictionary<string, string>>();
            }
        });

    // ------------------------------------------------------------ json helpers

    private static string Str(JsonNode? node, string name)
    {
        var value = node?[name];
        if (value is null) return string.Empty;
        return value.GetValueKind() == JsonValueKind.String
            ? value.GetValue<string>()
            : value.ToJsonString().Trim('"');
    }

    private static string? NullIfEmpty(string value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    private static int? Int(JsonNode? node, string name) =>
        ToDouble(node?[name]) is { } d ? (int)Math.Round(d) : null;

    private static double? Dbl(JsonNode? node, string name) => ToDouble(node?[name]);

    /// <summary>
    /// PRTG's status document returns counters as display strings such as
    /// "1.234" or "12 Sensors", so digits are extracted rather than parsed.
    /// </summary>
    private static int? IntLoose(JsonNode? node, string name)
    {
        var raw = Str(node, name);
        if (raw.Length == 0) return null;

        var digits = string.Concat(raw.Where(char.IsAsciiDigit));
        return digits.Length > 0 && int.TryParse(digits, out var value) ? value : null;
    }

    private static double? ToDouble(JsonNode? node)
    {
        if (node is null) return null;

        switch (node.GetValueKind())
        {
            case JsonValueKind.Number:
                return node.GetValue<double>();

            case JsonValueKind.String:
                var raw = node.GetValue<string>().Trim();
                if (raw.Length == 0) return null;
                return double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
                    ? v
                    : null;

            default:
                return null;
        }
    }

    private static string StripHtml(string value) =>
        value.Length == 0 ? value : HtmlTag.Replace(value, " ").Replace("&nbsp;", " ").Trim();

    // ------------------------------------------------------------ date helpers

    /// <summary>PRTG expects yyyy-MM-dd-HH-mm-ss in the core server's local time.</summary>
    private static string FormatPrtgDate(DateTime value) =>
        value.ToString("yyyy-MM-dd-HH-mm-ss", CultureInfo.InvariantCulture);

    /// <summary>
    /// historicdata returns a localised timestamp, optionally an interval
    /// ("17.10.2026 14:00:00 - 14:05:00"). The raw text is kept as the axis
    /// label when it can't be parsed, so the chart never shows "Invalid Date".
    /// </summary>
    private static (string Label, string? Iso) ParsePrtgTimestamp(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return (string.Empty, null);

        var head = raw.Split(" - ")[0].Trim();

        string[] formats =
        [
            "dd.MM.yyyy HH:mm:ss", "dd.MM.yyyy HH:mm",
            "MM/dd/yyyy HH:mm:ss", "M/d/yyyy h:mm:ss tt", "M/d/yyyy h:mm tt",
            "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss",
        ];

        if (DateTime.TryParseExact(head, formats, CultureInfo.InvariantCulture,
                DateTimeStyles.AllowWhiteSpaces, out var parsed)
            || DateTime.TryParse(head, CultureInfo.CurrentCulture,
                DateTimeStyles.AllowWhiteSpaces, out parsed))
        {
            return (parsed.ToString("HH:mm", CultureInfo.InvariantCulture),
                    parsed.ToString("o", CultureInfo.InvariantCulture));
        }

        return (head, null);
    }
}

public sealed class PrtgNotConfiguredException()
    : Exception("PRTG is not configured. Set Prtg:BaseUrl and either Prtg:ApiToken " +
                "or Prtg:Username and Prtg:PassHash.");

public sealed class PrtgApiException(string message, Exception? inner = null)
    : Exception(message, inner);
