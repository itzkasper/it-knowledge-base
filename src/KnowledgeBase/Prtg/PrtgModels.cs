namespace KnowledgeBase.Prtg;

/// <summary>
/// PRTG connection settings, bound from the "Prtg" section of appsettings.json.
/// Credentials stay on the server; the browser only ever sees /api/prtg/* results.
/// </summary>
public sealed class PrtgOptions
{
    public const string SectionName = "Prtg";

    /// <summary>Root URL of the PRTG core server, e.g. https://prtg.contoso.local</summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>PRTG API token (PRTG 23.x+). Preferred over username/passhash.</summary>
    public string? ApiToken { get; set; }

    /// <summary>Read-only PRTG user, used only when no ApiToken is set.</summary>
    public string? Username { get; set; }

    /// <summary>That user's passhash (PRTG: Setup &gt; Account Settings &gt; My Account).</summary>
    public string? PassHash { get; set; }

    /// <summary>Accept a self-signed PRTG certificate. Common on internal cores.</summary>
    public bool AllowUntrustedCertificate { get; set; }

    /// <summary>How long a PRTG response is reused before refetching.</summary>
    public int CacheSeconds { get; set; } = 15;

    /// <summary>Upper bound on rows pulled from the sensor table.</summary>
    public int MaxSensors { get; set; } = 2000;

    public int TimeoutSeconds { get; set; } = 20;

    public bool HasToken => !string.IsNullOrWhiteSpace(ApiToken);

    public bool HasBasicAuth =>
        !string.IsNullOrWhiteSpace(Username) && !string.IsNullOrWhiteSpace(PassHash);

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BaseUrl) && (HasToken || HasBasicAuth);
}

/// <summary>One row of the PRTG sensor table, normalised for the dashboard.</summary>
public sealed record PrtgSensor
{
    public int Id { get; init; }
    public int DeviceId { get; init; }
    public string Device { get; init; } = string.Empty;
    public string Sensor { get; init; } = string.Empty;
    public string Type { get; init; } = string.Empty;
    public string Group { get; init; } = string.Empty;
    public string Probe { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public int StatusRaw { get; init; }
    public string LastValue { get; init; } = string.Empty;
    public double? LastValueRaw { get; init; }
    public string Message { get; init; } = string.Empty;
    public string Tags { get; init; } = string.Empty;
    public int Priority { get; init; }

    /// <summary>Maps the PRTG status_raw code onto the dashboard's status palette.</summary>
    public string Severity => StatusRaw switch
    {
        3 or 10 => "good",       // Up, Unusual (still reporting)
        4 => "warning",          // Warning
        5 or 14 => "critical",   // Down, Down (partial)
        13 => "serious",         // Down acknowledged
        7 or 8 or 9 or 12 => "paused",
        _ => "unknown",
    };

    public bool IsPaused => StatusRaw is 7 or 8 or 9 or 12;

    /// <summary>True for the PRTG flow sensor families that carry NetFlow-style data.</summary>
    public bool IsFlowSensor
    {
        get
        {
            var t = Type.ToLowerInvariant();
            return t.Contains("netflow") || t.Contains("ipfix") || t.Contains("sflow")
                   || t.Contains("jflow") || t.Contains("packetsniffer");
        }
    }

    public bool IsSnmpSensor => Type.Contains("snmp", StringComparison.OrdinalIgnoreCase);
}

/// <summary>A single timestamped sample across a sensor's channels.</summary>
public sealed record PrtgHistoryPoint(string Label, string? Timestamp, double?[] Values);

public sealed record PrtgHistory(
    int SensorId,
    string[] Channels,
    IReadOnlyList<PrtgHistoryPoint> Points);

/// <summary>PRTG core server status counters, used for the dashboard header.</summary>
public sealed record PrtgServerStatus(
    string? Version,
    int? Alarms,
    int? AckAlarms,
    int? PartialAlarms,
    int? UpSensors,
    int? WarningSensors,
    int? DownSensors,
    int? PausedSensors,
    int? UnknownSensors,
    int? NewMessages,
    bool Reachable,
    string? Error);

public sealed record PrtgToplist(int Id, string Name, string Type);
