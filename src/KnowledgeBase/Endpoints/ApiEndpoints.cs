using KnowledgeBase.Prtg;
using Microsoft.Extensions.Options;

namespace KnowledgeBase.Endpoints;

public static class ApiEndpoints
{
    // ------------------------------------------------------------------ identity

    public static RouteGroupBuilder MapIdentityEndpoints(this RouteGroupBuilder api)
    {
        // Lets the page greet the signed-in technician without a login form.
        api.MapGet("/me", (HttpContext ctx) =>
        {
            var name = ctx.User?.Identity?.Name;
            var authenticated = ctx.User?.Identity?.IsAuthenticated ?? false;

            return Results.Ok(new
            {
                authenticated,
                // "CONTOSO\jsmith" -> "jsmith"
                name = string.IsNullOrEmpty(name) ? null : name,
                shortName = string.IsNullOrEmpty(name) ? null : name.Split('\\').Last(),
            });
        });

        return api;
    }

    // ---------------------------------------------------------------------- PRTG

    public static RouteGroupBuilder MapPrtgEndpoints(this RouteGroupBuilder api)
    {
        var prtg = api.MapGroup("/prtg");

        prtg.MapGet("/health", async (PrtgClient client, CancellationToken ct) =>
        {
            if (!client.IsConfigured)
                return Results.Ok(new { configured = false, reachable = false });

            var status = await client.GetServerStatusAsync(ct);
            return Results.Ok(new
            {
                configured = true,
                reachable = status.Reachable,
                version = status.Version,
                error = status.Error,
            });
        });

        // Headline counters for the dashboard's status row. Counts are derived
        // from the sensor table so they always agree with the lists below, with
        // the core-server document used only for version/alarm context.
        prtg.MapGet("/summary", async (
            PrtgClient client,
            IOptions<PrtgOptions> options,
            CancellationToken ct) =>
        {
            var sensors = await client.GetSensorsAsync(ct);
            var status = await client.GetServerStatusAsync(ct);

            return Results.Ok(new
            {
                version = status.Version,
                reachable = status.Reachable,
                // Base URL only — lets the UI deep-link a sensor into PRTG.
                // Credentials are never part of this value.
                webUrl = options.Value.BaseUrl.TrimEnd('/'),
                total = sensors.Count,
                up = sensors.Count(s => s.Severity == "good"),
                warning = sensors.Count(s => s.Severity == "warning"),
                down = sensors.Count(s => s.Severity is "critical" or "serious"),
                paused = sensors.Count(s => s.IsPaused),
                unknown = sensors.Count(s => s.Severity == "unknown" && !s.IsPaused),
                flowSensors = sensors.Count(s => s.IsFlowSensor),
                snmpSensors = sensors.Count(s => s.IsSnmpSensor),
            });
        });

        // Sensors currently in a non-OK state, worst first. Paused sensors are
        // excluded: a paused sensor is a maintenance state, not an alarm.
        prtg.MapGet("/alarms", async (PrtgClient client, int? limit, CancellationToken ct) =>
        {
            var sensors = await client.GetSensorsAsync(ct);
            var take = Math.Clamp(limit ?? 25, 1, 200);

            var alarms = sensors
                .Where(s => !s.IsPaused && s.Severity is "critical" or "serious" or "warning")
                .OrderBy(s => s.Severity switch
                {
                    "critical" => 0,
                    "serious" => 1,
                    _ => 2,
                })
                .ThenByDescending(s => s.Priority)
                .Take(take)
                .Select(Project);

            return Results.Ok(alarms);
        });

        // Flow sensors (NetFlow v5/v9, IPFIX, sFlow, jFlow, packet sniffer).
        prtg.MapGet("/netflow", async (PrtgClient client, CancellationToken ct) =>
        {
            var sensors = await client.GetSensorsAsync(ct);
            return Results.Ok(sensors
                .Where(s => s.IsFlowSensor)
                .OrderBy(s => s.Device, StringComparer.CurrentCultureIgnoreCase)
                .ThenBy(s => s.Sensor, StringComparer.CurrentCultureIgnoreCase)
                .Select(Project));
        });

        // SNMP sensors, grouped by device so the panel can render per-device cards.
        prtg.MapGet("/snmp", async (PrtgClient client, int? limit, CancellationToken ct) =>
        {
            var sensors = await client.GetSensorsAsync(ct);
            var take = Math.Clamp(limit ?? 12, 1, 100);

            var groups = sensors
                .Where(s => s.IsSnmpSensor)
                .GroupBy(s => new { s.DeviceId, s.Device })
                .OrderByDescending(g => g.Count(s => s.Severity is "critical" or "serious"))
                .ThenBy(g => g.Key.Device, StringComparer.CurrentCultureIgnoreCase)
                .Take(take)
                .Select(g => new
                {
                    deviceId = g.Key.DeviceId,
                    device = g.Key.Device,
                    total = g.Count(),
                    down = g.Count(s => s.Severity is "critical" or "serious"),
                    warning = g.Count(s => s.Severity == "warning"),
                    sensors = g
                        .OrderByDescending(s => s.StatusRaw)
                        .ThenBy(s => s.Sensor, StringComparer.CurrentCultureIgnoreCase)
                        .Select(Project),
                });

            return Results.Ok(groups);
        });

        // Channel history behind the traffic charts.
        prtg.MapGet("/sensors/{id:int}/history", async (
            int id, int? hours, int? avg, PrtgClient client, CancellationToken ct) =>
        {
            var history = await client.GetHistoryAsync(
                id,
                Math.Clamp(hours ?? 6, 1, 720),
                Math.Clamp(avg ?? 300, 0, 86400),
                ct);

            return Results.Ok(new
            {
                sensorId = history.SensorId,
                channels = history.Channels,
                points = history.Points.Select(p => new
                {
                    label = p.Label,
                    t = p.Timestamp,
                    v = p.Values,
                }),
            });
        });

        prtg.MapGet("/sensors/{id:int}/toplists", async (
            int id, PrtgClient client, CancellationToken ct) =>
                Results.Ok(await client.GetToplistsAsync(id, ct)));

        prtg.MapGet("/sensors/{id:int}/toplists/{toplistId:int}", async (
            int id, int toplistId, PrtgClient client, CancellationToken ct) =>
        {
            var rows = await client.GetToplistDataAsync(id, toplistId, ct);
            var columns = rows.Count == 0
                ? Array.Empty<string>()
                : rows[0].Keys.ToArray();

            return Results.Ok(new { columns, rows });
        });

        // Every PRTG failure lands here as a clean JSON problem the UI can show
        // inline, rather than a 500 that blanks the dashboard.
        prtg.AddEndpointFilter(async (ctx, next) =>
        {
            try
            {
                return await next(ctx);
            }
            catch (PrtgNotConfiguredException ex)
            {
                return Results.Problem(
                    title: "PRTG is not configured",
                    detail: ex.Message,
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
            catch (PrtgApiException ex)
            {
                return Results.Problem(
                    title: "PRTG request failed",
                    detail: ex.Message,
                    statusCode: StatusCodes.Status502BadGateway);
            }
            catch (TaskCanceledException) when (!ctx.HttpContext.RequestAborted.IsCancellationRequested)
            {
                return Results.Problem(
                    title: "PRTG timed out",
                    detail: "The PRTG core server did not respond in time.",
                    statusCode: StatusCodes.Status504GatewayTimeout);
            }
            catch (HttpRequestException ex)
            {
                return Results.Problem(
                    title: "PRTG unreachable",
                    detail: ex.Message,
                    statusCode: StatusCodes.Status502BadGateway);
            }
        });

        return api;
    }

    /// <summary>Shapes a sensor for the browser — no PRTG internals leak out.</summary>
    private static object Project(PrtgSensor s) => new
    {
        id = s.Id,
        deviceId = s.DeviceId,
        device = s.Device,
        sensor = s.Sensor,
        type = s.Type,
        group = s.Group,
        probe = s.Probe,
        status = s.Status,
        severity = s.Severity,
        paused = s.IsPaused,
        lastValue = s.LastValue,
        lastValueRaw = s.LastValueRaw,
        message = s.Message,
        priority = s.Priority,
    };
}
