using KnowledgeBase.Endpoints;
using KnowledgeBase.Prtg;
using KnowledgeBase.Sdp;
using Microsoft.AspNetCore.Server.IISIntegration;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------------- configuration

builder.Services
    .AddOptions<PrtgOptions>()
    .Bind(builder.Configuration.GetSection(PrtgOptions.SectionName));

builder.Services
    .AddOptions<SdpOptions>()
    .Bind(builder.Configuration.GetSection(SdpOptions.SectionName));

builder.Services.AddMemoryCache();

// ------------------------------------------------------------------- PRTG client

builder.Services.AddHttpClient<PrtgClient>((sp, client) =>
    {
        var opt = sp.GetRequiredService<IConfiguration>()
            .GetSection(PrtgOptions.SectionName).Get<PrtgOptions>() ?? new PrtgOptions();

        client.Timeout = TimeSpan.FromSeconds(Math.Clamp(opt.TimeoutSeconds, 5, 120));
        client.DefaultRequestHeaders.UserAgent.ParseAdd("ITKnowledgeBase-Dashboard/1.0");
    })
    .ConfigurePrimaryHttpMessageHandler(sp =>
    {
        var opt = sp.GetRequiredService<IConfiguration>()
            .GetSection(PrtgOptions.SectionName).Get<PrtgOptions>() ?? new PrtgOptions();

        var handler = new HttpClientHandler
        {
            AutomaticDecompression = System.Net.DecompressionMethods.All,
        };

        if (opt.AllowUntrustedCertificate)
        {
            // Internal PRTG cores commonly use the self-signed certificate PRTG
            // generates at install time. Scoped to this client only.
            handler.ServerCertificateCustomValidationCallback =
                (_, _, _, _) => true;
        }

        return handler;
    });

// ------------------------------------------------------- ServiceDesk Plus client

builder.Services.AddHttpClient<SdpClient>((sp, client) =>
{
    var opt = sp.GetRequiredService<IConfiguration>()
        .GetSection(SdpOptions.SectionName).Get<SdpOptions>() ?? new SdpOptions();

    client.Timeout = TimeSpan.FromSeconds(Math.Clamp(opt.TimeoutSeconds, 5, 120));
    client.DefaultRequestHeaders.UserAgent.ParseAdd("ITKnowledgeBase-Dashboard/1.0");
});

// ---------------------------------------------------------------- authentication

// In-process and out-of-process IIS both surface the Windows identity through
// this scheme; enable Windows Authentication (and disable Anonymous) on the IIS
// site for it to populate. See DEPLOYMENT.md.
builder.Services.AddAuthentication(IISDefaults.AuthenticationScheme);
builder.Services.AddAuthorization();

builder.Services.Configure<IISServerOptions>(o => o.AuthenticationDisplayName = "Windows");

var requireAuth = builder.Configuration.GetValue("Security:RequireAuthenticatedUser", true);

// ------------------------------------------------------------------------- build

var app = builder.Build();

app.UseStatusCodePagesWithReExecute("/error.html");

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

// Security headers. The CSP is strict because the site ships no third-party
// scripts — everything under wwwroot is first-party and self-contained.
app.Use(async (ctx, next) =>
{
    var headers = ctx.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["X-Frame-Options"] = "SAMEORIGIN";
    headers["Referrer-Policy"] = "same-origin";
    headers["Content-Security-Policy"] =
        "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
        "script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'";
    await next();
});

// Serve .md as text so the browser can fetch article bodies directly.
var contentTypes = new FileExtensionContentTypeProvider();
contentTypes.Mappings[".md"] = "text/markdown; charset=utf-8";
contentTypes.Mappings[".webmanifest"] = "application/manifest+json";

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = contentTypes,
    OnPrepareResponse = ctx =>
    {
        // Markdown and the search index change whenever an author edits a doc,
        // so they must revalidate; fingerprint-free assets get a short cache.
        var path = ctx.File.Name;
        var mustRevalidate =
            path.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ||
            path.Equals("index.json", StringComparison.OrdinalIgnoreCase) ||
            path.EndsWith(".html", StringComparison.OrdinalIgnoreCase);

        ctx.Context.Response.GetTypedHeaders().CacheControl = mustRevalidate
            ? new CacheControlHeaderValue { NoCache = true, MustRevalidate = true }
            : new CacheControlHeaderValue { Public = true, MaxAge = TimeSpan.FromHours(1) };
    },
});

app.UseAuthentication();
app.UseAuthorization();

// -------------------------------------------------------------------- endpoints

var api = app.MapGroup("/api");
if (requireAuth) api = api.RequireAuthorization();

api.MapIdentityEndpoints();
api.MapPrtgEndpoints();
api.MapSdpEndpoints();

app.Run();
