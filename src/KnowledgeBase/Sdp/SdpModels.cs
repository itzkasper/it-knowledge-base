namespace KnowledgeBase.Sdp;

/// <summary>
/// ManageEngine ServiceDesk Plus Cloud (OnDemand) connection settings, bound
/// from the "Sdp" section of appsettings.
/// <para>
/// Cloud authenticates with Zoho OAuth 2.0: a long-lived refresh token is
/// exchanged for an access token that expires hourly. The refresh token and
/// client secret stay on the server — the browser only ever sees /api/sdp/*
/// results.
/// </para>
/// </summary>
public sealed class SdpOptions
{
    public const string SectionName = "Sdp";

    /// <summary>
    /// SDP Cloud API host for your datacenter, e.g.
    /// https://sdpondemand.manageengine.com
    /// </summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>
    /// Zoho accounts host for the SAME datacenter as <see cref="BaseUrl"/>,
    /// e.g. https://accounts.zoho.com. Mismatching the two is the most common
    /// cause of "invalid_code" on refresh.
    /// </summary>
    public string AccountsUrl { get; set; } = "https://accounts.zoho.com";

    /// <summary>
    /// Path to the requests API. Some portals are addressed as
    /// /app/{portal}/api/v3/requests; others simply /api/v3/requests.
    /// </summary>
    public string RequestsPath { get; set; } = "/api/v3/requests";

    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;

    /// <summary>Self-client refresh token with the SDPOnDemand.requests.READ scope.</summary>
    public string RefreshToken { get; set; } = string.Empty;

    /// <summary>
    /// Link template for opening a ticket in SDP. "{id}" is substituted.
    /// Relative values are resolved against <see cref="BaseUrl"/>.
    /// </summary>
    public string TicketUrlTemplate { get; set; } = "/app/itdesk/ui/requests/{id}/details";

    /// <summary>Priorities treated as critical, matched case-insensitively.</summary>
    public string[] CriticalPriorities { get; set; } = ["High", "Urgent"];

    /// <summary>Statuses treated as finished, and therefore never shown.</summary>
    public string[] ClosedStatuses { get; set; } = ["Closed", "Resolved", "Cancelled"];

    /// <summary>How many tickets to pull before filtering server-side.</summary>
    public int FetchRowCount { get; set; } = 100;

    public int CacheSeconds { get; set; } = 60;
    public int TimeoutSeconds { get; set; } = 20;

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BaseUrl) &&
        !string.IsNullOrWhiteSpace(ClientId) &&
        !string.IsNullOrWhiteSpace(ClientSecret) &&
        !string.IsNullOrWhiteSpace(RefreshToken);
}

/// <summary>Which slice of tickets the dashboard panel is showing.</summary>
public enum SdpTicketFilter
{
    /// <summary>Open tickets at a critical priority.</summary>
    Critical,

    /// <summary>Open tickets past their SLA due-by time.</summary>
    Overdue,

    /// <summary>Open tickets with no technician assigned.</summary>
    Unassigned,
}

/// <summary>One ServiceDesk Plus request, normalised for the dashboard.</summary>
public sealed record SdpTicket
{
    public string Id { get; init; } = string.Empty;
    public string Subject { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public string Priority { get; init; } = string.Empty;
    public string Requester { get; init; } = string.Empty;
    public string? Technician { get; init; }
    public DateTimeOffset? CreatedTime { get; init; }
    public DateTimeOffset? DueByTime { get; init; }
    public bool IsOverdue { get; init; }

    public bool IsUnassigned => string.IsNullOrWhiteSpace(Technician);

    public bool IsCritical(SdpOptions options) =>
        options.CriticalPriorities.Any(p =>
            p.Equals(Priority, StringComparison.OrdinalIgnoreCase));

    public bool IsOpen(SdpOptions options) =>
        !options.ClosedStatuses.Any(s =>
            s.Equals(Status, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Maps onto the dashboard's status palette, so a ticket row reads the same
    /// way as a PRTG alarm row. Overdue outranks priority: a breached SLA is a
    /// harder fact than a priority someone typed in.
    /// </summary>
    public string Severity(SdpOptions options)
    {
        if (IsOverdue) return "critical";
        if (Priority.Equals("Urgent", StringComparison.OrdinalIgnoreCase)) return "critical";
        if (IsCritical(options)) return "warning";
        return "unknown";
    }
}

public sealed record SdpSummary(
    bool Configured,
    bool Reachable,
    int Critical,
    int Overdue,
    int Unassigned,
    int OpenTotal,
    string? Error);

public sealed class SdpNotConfiguredException()
    : Exception("ServiceDesk Plus is not configured. Set Sdp:BaseUrl, Sdp:ClientId, " +
                "Sdp:ClientSecret and Sdp:RefreshToken.");

public sealed class SdpApiException(string message, Exception? inner = null)
    : Exception(message, inner);
