using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace KnowledgeBase.Sdp;

/// <summary>
/// Read-only client for the ServiceDesk Plus Cloud (OnDemand) v3 API.
/// <para>
/// Only the requests list is exposed. As with <c>PrtgClient</c>, there is no
/// generic passthrough, so the stored OAuth credentials cannot be used to
/// reach arbitrary SDP endpoints from the browser.
/// </para>
/// </summary>
public sealed class SdpClient(
    HttpClient http,
    IOptions<SdpOptions> options,
    IMemoryCache cache,
    ILogger<SdpClient> log)
{
    private const string AccessTokenCacheKey = "sdp::access_token";
    private const string TicketsCacheKey = "sdp::tickets";

    /// <summary>Serialises token refresh so a burst of requests triggers one exchange.</summary>
    private static readonly SemaphoreSlim TokenLock = new(1, 1);

    private readonly SdpOptions _opt = options.Value;

    public bool IsConfigured => _opt.IsConfigured;

    public SdpOptions Options => _opt;

    // ------------------------------------------------------------------ OAuth

    /// <summary>
    /// Returns a valid access token, refreshing it when it is missing or close
    /// to expiry. Zoho access tokens last an hour; we renew a minute early so a
    /// request never travels with a token that expires mid-flight.
    /// </summary>
    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        if (!_opt.IsConfigured) throw new SdpNotConfiguredException();

        if (cache.TryGetValue(AccessTokenCacheKey, out string? cached) &&
            !string.IsNullOrEmpty(cached))
        {
            return cached;
        }

        await TokenLock.WaitAsync(ct);
        try
        {
            // Another caller may have refreshed while we waited.
            if (cache.TryGetValue(AccessTokenCacheKey, out string? fresh) &&
                !string.IsNullOrEmpty(fresh))
            {
                return fresh;
            }

            var token = await RefreshAccessTokenAsync(ct);
            return token;
        }
        finally
        {
            TokenLock.Release();
        }
    }

    private async Task<string> RefreshAccessTokenAsync(CancellationToken ct)
    {
        var url = $"{_opt.AccountsUrl.TrimEnd('/')}/oauth/v2/token";

        // Credentials go in the form body, never the query string: a URL can
        // end up in proxy logs and exception messages.
        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = _opt.RefreshToken,
            ["client_id"] = _opt.ClientId,
            ["client_secret"] = _opt.ClientSecret,
        });

        using var response = await http.PostAsync(url, content, ct);
        var body = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            throw new SdpApiException(
                $"Zoho token refresh failed ({(int)response.StatusCode}). " +
                "Check Sdp:ClientId, Sdp:ClientSecret, Sdp:RefreshToken, and that " +
                "Sdp:AccountsUrl matches the datacenter of Sdp:BaseUrl.");
        }

        JsonNode? json;
        try
        {
            json = JsonNode.Parse(body);
        }
        catch (JsonException ex)
        {
            throw new SdpApiException("Zoho token endpoint did not return JSON.", ex);
        }

        // Zoho answers 200 OK with an {"error": "..."} body on bad credentials.
        var error = json?["error"]?.ToString();
        if (!string.IsNullOrEmpty(error))
        {
            throw new SdpApiException(
                $"Zoho token refresh rejected: {error}. " +
                "'invalid_client' usually means the client ID/secret is from a " +
                "different datacenter; 'invalid_code' means the refresh token is " +
                "revoked or was issued for different scopes.");
        }

        var accessToken = json?["access_token"]?.ToString();
        if (string.IsNullOrEmpty(accessToken))
        {
            throw new SdpApiException("Zoho token response contained no access_token.");
        }

        var expiresIn = 3600d;
        if (json?["expires_in"] is { } exp && double.TryParse(
                exp.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
        {
            // Some Zoho datacenters report milliseconds rather than seconds.
            expiresIn = parsed > 86400 ? parsed / 1000d : parsed;
        }

        var lifetime = TimeSpan.FromSeconds(Math.Max(60, expiresIn - 60));
        cache.Set(AccessTokenCacheKey, accessToken, lifetime);

        log.LogInformation("Refreshed ServiceDesk Plus access token; valid for {Minutes:F0} min.",
            lifetime.TotalMinutes);

        return accessToken;
    }

    // --------------------------------------------------------------- requests

    /// <summary>
    /// All open tickets, fetched once and partitioned in memory. Every panel
    /// filter reads this list rather than issuing its own SDP query.
    /// </summary>
    public Task<IReadOnlyList<SdpTicket>> GetOpenTicketsAsync(CancellationToken ct = default)
    {
        if (!_opt.IsConfigured) throw new SdpNotConfiguredException();

        if (_opt.CacheSeconds <= 0) return FetchOpenTicketsAsync(ct);

        return cache.GetOrCreateAsync(TicketsCacheKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(_opt.CacheSeconds);
            return FetchOpenTicketsAsync(ct);
        })!;
    }

    private async Task<IReadOnlyList<SdpTicket>> FetchOpenTicketsAsync(CancellationToken ct)
    {
        var json = await GetRequestsAsync(ct);

        var rows = json?["requests"]?.AsArray();
        if (rows is null) return Array.Empty<SdpTicket>();

        var tickets = new List<SdpTicket>(rows.Count);
        foreach (var row in rows)
        {
            if (row is null) continue;

            tickets.Add(new SdpTicket
            {
                Id = Str(row, "id"),
                Subject = Str(row, "subject"),
                Status = Str(row["status"], "name"),
                Priority = Str(row["priority"], "name"),
                Requester = Str(row["requester"], "name"),
                Technician = NullIfEmpty(Str(row["technician"], "name")),
                CreatedTime = ParseSdpTime(row["created_time"]),
                DueByTime = ParseSdpTime(row["due_by_time"]),
                IsOverdue = Bool(row, "is_overdue"),
            });
        }

        // Closed statuses are excluded in the query too, but SDP installs
        // rename statuses freely, so the configured list is applied here as well.
        return tickets.Where(t => t.IsOpen(_opt)).ToList();
    }

    private async Task<JsonNode?> GetRequestsAsync(CancellationToken ct)
    {
        var token = await GetAccessTokenAsync(ct);

        // Two plain AND conditions — no mixed and/or grouping, whose semantics
        // vary between SDP versions.
        var criteria = new JsonArray();
        for (var i = 0; i < _opt.ClosedStatuses.Length; i++)
        {
            var clause = new JsonObject
            {
                ["field"] = "status.name",
                ["condition"] = "neq",
                ["value"] = _opt.ClosedStatuses[i],
            };
            if (i > 0) clause["logical_operator"] = "and";
            criteria.Add(clause);
        }

        var listInfo = new JsonObject
        {
            ["list_info"] = new JsonObject
            {
                ["row_count"] = Math.Clamp(_opt.FetchRowCount, 1, 500),
                ["start_index"] = 1,
                ["sort_field"] = "created_time",
                ["sort_order"] = "desc",
                ["get_total_count"] = true,
                ["search_criteria"] = criteria,
            },
        };

        var url = BuildRequestsUrl() +
                  "?input_data=" + Uri.EscapeDataString(listInfo.ToJsonString());

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Authorization", "Zoho-oauthtoken " + token);
        request.Headers.Accept.Add(
            new MediaTypeWithQualityHeaderValue("application/vnd.manageengine.sdp.v3+json"));

        using var response = await http.SendAsync(request, ct);

        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            // The cached token was revoked early; drop it so the next call retries.
            cache.Remove(AccessTokenCacheKey);
            throw new SdpApiException(
                "ServiceDesk Plus rejected the access token (401). It will be " +
                "refreshed on the next attempt; if this repeats, confirm the " +
                "refresh token still carries the SDPOnDemand.requests.READ scope.");
        }

        var body = await response.Content.ReadAsStringAsync(ct);

        if (!response.IsSuccessStatusCode)
        {
            throw new SdpApiException(
                $"ServiceDesk Plus returned {(int)response.StatusCode} {response.ReasonPhrase}. " +
                Summarise(body));
        }

        try
        {
            var json = JsonNode.Parse(body);
            var status = json?["response_status"];

            // SDP reports application errors inside a 200 response.
            var statusCode = status?["status_code"]?.ToString();
            if (statusCode is not null && statusCode != "2000")
            {
                var messages = status?["messages"]?.AsArray();
                var first = messages is { Count: > 0 }
                    ? messages[0]?["message"]?.ToString()
                    : null;

                throw new SdpApiException(
                    $"ServiceDesk Plus reported status {statusCode}" +
                    (first is null ? "." : $": {first}"));
            }

            return json;
        }
        catch (JsonException ex)
        {
            throw new SdpApiException(
                "ServiceDesk Plus did not return JSON. Check that Sdp:RequestsPath is " +
                "correct for your portal (some portals need /app/{portal}/api/v3/requests).",
                ex);
        }
    }

    private string BuildRequestsUrl() =>
        _opt.BaseUrl.TrimEnd('/') + "/" + _opt.RequestsPath.TrimStart('/');

    /// <summary>Trims an error body so a stack trace never carries a whole HTML page.</summary>
    private static string Summarise(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return string.Empty;
        var flat = body.Replace('\n', ' ').Replace('\r', ' ').Trim();
        return flat.Length <= 200 ? flat : flat[..200] + "…";
    }

    // ----------------------------------------------------------- partitioning

    /// <summary>Applies one of the dashboard's panel filters, worst first.</summary>
    public async Task<IReadOnlyList<SdpTicket>> GetTicketsAsync(
        SdpTicketFilter filter, int limit, CancellationToken ct = default)
    {
        var open = await GetOpenTicketsAsync(ct);

        var matching = filter switch
        {
            SdpTicketFilter.Overdue => open.Where(t => t.IsOverdue),
            SdpTicketFilter.Unassigned => open.Where(t => t.IsUnassigned),
            _ => open.Where(t => t.IsCritical(_opt)),
        };

        return matching
            .OrderByDescending(t => t.IsOverdue)
            .ThenByDescending(t => t.Priority.Equals("Urgent", StringComparison.OrdinalIgnoreCase))
            .ThenBy(t => t.DueByTime ?? DateTimeOffset.MaxValue)
            .ThenByDescending(t => t.CreatedTime ?? DateTimeOffset.MinValue)
            .Take(Math.Clamp(limit, 1, 100))
            .ToList();
    }

    /// <summary>
    /// Counters for the panel's filter buttons. Returns an unreachable summary
    /// rather than throwing, so one failing SDP call cannot blank the page.
    /// </summary>
    public async Task<SdpSummary> GetSummaryAsync(CancellationToken ct = default)
    {
        if (!_opt.IsConfigured)
            return new SdpSummary(false, false, 0, 0, 0, 0, null);

        try
        {
            var open = await GetOpenTicketsAsync(ct);

            return new SdpSummary(
                Configured: true,
                Reachable: true,
                Critical: open.Count(t => t.IsCritical(_opt)),
                Overdue: open.Count(t => t.IsOverdue),
                Unassigned: open.Count(t => t.IsUnassigned),
                OpenTotal: open.Count,
                Error: null);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "ServiceDesk Plus summary failed.");
            return new SdpSummary(true, false, 0, 0, 0, 0, ex.Message);
        }
    }

    /// <summary>Absolute link to a ticket in SDP, or null when not configured.</summary>
    public string? TicketUrl(string id)
    {
        if (string.IsNullOrWhiteSpace(_opt.TicketUrlTemplate) ||
            string.IsNullOrWhiteSpace(id))
        {
            return null;
        }

        var template = _opt.TicketUrlTemplate.Replace("{id}", Uri.EscapeDataString(id));

        return template.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? template
            : _opt.BaseUrl.TrimEnd('/') + "/" + template.TrimStart('/');
    }

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

    private static bool Bool(JsonNode? node, string name)
    {
        var value = node?[name];
        if (value is null) return false;

        return value.GetValueKind() switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => bool.TryParse(value.GetValue<string>(), out var b) && b,
            _ => false,
        };
    }

    /// <summary>
    /// SDP time fields are objects: { "value": "1760696400000", "display_value": "…" }
    /// where value is epoch milliseconds as a string. An empty ticket field
    /// comes back as an empty object or an empty value.
    /// </summary>
    private static DateTimeOffset? ParseSdpTime(JsonNode? node)
    {
        if (node is null) return null;

        var raw = node.GetValueKind() == JsonValueKind.Object
            ? node["value"]?.ToString()
            : node.ToString();

        if (string.IsNullOrWhiteSpace(raw)) return null;

        if (long.TryParse(raw.Trim('"'), NumberStyles.Integer,
                CultureInfo.InvariantCulture, out var millis) && millis > 0)
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(millis);
        }

        return DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed
            : null;
    }
}
