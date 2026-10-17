# Deploying to Windows Server 2019 / IIS

Target: IIS 10 on Windows Server 2019, ASP.NET Core 8 hosted **in-process**,
Windows Authentication against AD.

---

## 1. Server prerequisites

Install in this order. The order matters: installing the Hosting Bundle before
IIS leaves the ASP.NET Core module unregistered.

### 1.1 IIS with the required features

```powershell
Install-WindowsFeature -Name `
    Web-Server, Web-Common-Http, Web-Default-Doc, Web-Static-Content, `
    Web-Http-Errors, Web-Http-Redirect, `
    Web-Windows-Auth, Web-Filtering, `
    Web-Stat-Compression, Web-Dyn-Compression, `
    Web-Http-Logging, Web-Mgmt-Console `
    -IncludeManagementTools
```

`Web-Windows-Auth` is the one people forget — without it the Windows
Authentication option does not appear in IIS Manager.

### 1.2 .NET 8 Hosting Bundle

Download **ASP.NET Core 8 Runtime — Windows Hosting Bundle** from
<https://dotnet.microsoft.com/download/dotnet/8.0> and install it, then:

```powershell
net stop was /y
net start w3svc

# Confirm the module registered
Get-WebGlobalModule | Where-Object Name -like 'AspNetCoreModule*'
```

You should see `AspNetCoreModuleV2`. If you don't, repair the Hosting Bundle
install — it ran before IIS was present.

### 1.3 Build toolchain

Only needed if you build **on** the server. Install the
[.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0). Otherwise build
on a workstation and copy the publish output across.

---

## 2. Create the site

```powershell
Import-Module WebAdministration

$sitePath = 'C:\inetpub\KnowledgeBase'
New-Item -ItemType Directory -Path $sitePath -Force | Out-Null

# No managed runtime: the app runs in its own process, not the CLR.
New-WebAppPool -Name 'KnowledgeBase'
Set-ItemProperty 'IIS:\AppPools\KnowledgeBase' -Name managedRuntimeVersion -Value ''
Set-ItemProperty 'IIS:\AppPools\KnowledgeBase' -Name startMode -Value 'AlwaysRunning'

New-Website -Name 'KnowledgeBase' `
    -PhysicalPath $sitePath `
    -ApplicationPool 'KnowledgeBase' `
    -Port 80 `
    -HostHeader 'kb.yourdomain.local'

# Keep the worker warm so the first request of the morning isn't slow.
Set-ItemProperty 'IIS:\Sites\KnowledgeBase' -Name applicationDefaults.preloadEnabled -Value $true
Set-ItemProperty 'IIS:\AppPools\KnowledgeBase' -Name processModel.idleTimeout -Value '00:00:00'
Set-ItemProperty 'IIS:\AppPools\KnowledgeBase' -Name recycling.periodicRestart.time -Value '00:00:00'
```

### Authentication

```powershell
Set-WebConfigurationProperty -Filter '/system.webServer/security/authentication/windowsAuthentication' `
    -Name enabled -Value $true -PSPath 'IIS:\' -Location 'KnowledgeBase'

Set-WebConfigurationProperty -Filter '/system.webServer/security/authentication/anonymousAuthentication' `
    -Name enabled -Value $false -PSPath 'IIS:\' -Location 'KnowledgeBase'
```

Both are also declared in `web.config`, but the site-level settings above are
what IIS actually enforces, and the feature must be installed for either to
apply.

> **Kerberos note.** If the app pool runs as a domain service account rather
> than `ApplicationPoolIdentity`, register an SPN for the site's hostname or
> clients silently fall back to NTLM:
>
> ```powershell
> setspn -S HTTP/kb.yourdomain.local CONTOSO\svc-kb-apppool
> ```

### Folder permissions

```powershell
$acl = Get-Acl $sitePath
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    'IIS AppPool\KnowledgeBase', 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl $sitePath $acl
```

The app writes nothing except optional stdout logs, so read and execute is
enough. If you enable `stdoutLogEnabled`, grant Modify on the `logs` subfolder
only.

### HTTPS

Bind a certificate and redirect. An internal AD CS certificate is fine.

```powershell
New-WebBinding -Name 'KnowledgeBase' -Protocol https -Port 443 -HostHeader 'kb.yourdomain.local' -SslFlags 1

$cert = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object Subject -like '*kb.yourdomain.local*' |
    Select-Object -First 1

New-Item -Path "IIS:\SslBindings\!443!kb.yourdomain.local" -Value $cert -SSLFlags 1
```

HSTS is enabled by the app outside Development, so serve HTTPS before you
advertise the URL — a browser that sees the HSTS header will refuse plain HTTP
afterwards.

---

## 3. Deploy the application

From a checkout on the server:

```powershell
cd C:\source\it-knowledge-base
.\tools\Publish-Site.ps1 -Destination 'C:\inetpub\KnowledgeBase' -AppPool 'KnowledgeBase'
```

Or build on a workstation and copy:

```powershell
dotnet publish .\src\KnowledgeBase\KnowledgeBase.csproj -c Release -o .\publish
# then copy .\publish\* to C:\inetpub\KnowledgeBase on the server
```

`Publish-Site.ps1` stops the app pool during the copy (the hosting module keeps
`KnowledgeBase.dll` open while running) and preserves the destination's
`appsettings.json` so live credentials survive a redeploy.

---

## 4. Connect PRTG

Edit `C:\inetpub\KnowledgeBase\appsettings.json`:

```json
{
  "Prtg": {
    "BaseUrl": "https://prtg.yourdomain.local",
    "ApiToken": "ABCDEF1234567890",
    "AllowUntrustedCertificate": true,
    "CacheSeconds": 15
  }
}
```

### Getting credentials

**API token (preferred, PRTG 23.x and later)**
PRTG → *Setup* → *Account Settings* → *My Account* → *API Keys* → create a key
with **read-only** access.

**Username + passhash (older cores)**
PRTG → *Setup* → *Account Settings* → *My Account* → *API* section shows the
passhash. Use a dedicated read-only PRTG user, not an administrator:

```json
"Prtg": {
  "BaseUrl": "https://prtg.yourdomain.local",
  "Username": "dashboard-reader",
  "PassHash": "1234567890"
}
```

### Keeping the credential out of the file

Environment variables override `appsettings.json` and never appear in the
repository or in a config backup:

```powershell
Set-ItemProperty 'IIS:\AppPools\KnowledgeBase' -Name processModel.environmentVariables `
    -Value @{ 'Prtg__ApiToken' = 'ABCDEF1234567890' }
Restart-WebAppPool -Name 'KnowledgeBase'
```

The double underscore is the .NET section separator — `Prtg__ApiToken` maps to
`Prtg:ApiToken`.

### Certificate trust

`AllowUntrustedCertificate: true` accepts PRTG's self-signed certificate. The
cleaner option is to import PRTG's certificate into the server's
`LocalMachine\Root` store and leave the flag `false`.

### Firewall

The web server needs outbound TCP 443 (or 80) to the PRTG core. PRTG itself
needs inbound 2055/UDP from the exporting devices — that's unrelated to this
site but is the usual reason the NetFlow panel is empty.

---

## 5. Verify

```powershell
# Proxy reachable and authenticated against PRTG
Invoke-RestMethod 'http://localhost/api/prtg/health' -UseDefaultCredentials

# Expect: configured=True, reachable=True, a version string
```

Then in a browser, signed in as a domain user:

| Check | Expected |
|-------|----------|
| `https://kb.yourdomain.local/` | Dashboard, no credential prompt |
| Status tiles | Real sensor counts, not `--` |
| Traffic by channel | A chart, or a clear "no flow sensors" message |
| Your username, top right | Your account name |
| `https://kb.yourdomain.local/docs.html` | Category tree and documents |
| Search for "SNMP" | Matching documents |

A credential prompt in a browser on the domain means Windows Auth is enabled
but the site isn't in the Local Intranet zone, or an SPN is missing.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| **HTTP 500.19** | Hosting Bundle missing or installed before IIS | Reinstall/repair the bundle, then `net stop was /y; net start w3svc` |
| **HTTP 500.30** | App failed to start | Set `stdoutLogEnabled="true"` in `web.config`, reproduce, read `logs\stdout*.log` |
| **HTTP 500.31** | Runtime version mismatch | Confirm the ASP.NET Core 8 runtime: `dotnet --list-runtimes` |
| **HTTP 502.5** | Wrong `processPath`/`arguments` | Use the publish output's generated `web.config`, don't hand-edit |
| **HTTP 401.2** | Windows Auth not installed | `Install-WindowsFeature Web-Windows-Auth`, then enable it on the site |
| **Repeated credential prompts** | Site not in Local Intranet zone, or missing SPN | Add the hostname via GPO; register the SPN |
| **`.md` requests return 404** | MIME type not registered | `web.config` declares it; confirm `staticContent` wasn't overridden higher up |
| **API returns 503** | PRTG section not configured | Set `BaseUrl` plus a token or username/passhash |
| **API returns 502** | Token rejected, or PRTG unreachable | Test the URL from the server; check the certificate flag |
| **Dashboard empty, docs fine** | PRTG only | Expected behaviour — the two are independent by design |
| **Top talkers panel empty** | No toplist on the sensor | Enable one in PRTG: sensor → *Settings* → *Toplists* |
| **Traffic chart unreadable** | Too many channels | Group channels in the sensor's *Channel Selection* |

### Reading app logs

```powershell
# Enable temporarily
(Get-Content C:\inetpub\KnowledgeBase\web.config) `
    -replace 'stdoutLogEnabled="false"', 'stdoutLogEnabled="true"' |
    Set-Content C:\inetpub\KnowledgeBase\web.config

New-Item -ItemType Directory C:\inetpub\KnowledgeBase\logs -Force
Restart-WebAppPool -Name 'KnowledgeBase'

# Reproduce, then
Get-Content C:\inetpub\KnowledgeBase\logs\stdout*.log -Tail 60
```

Turn it back off afterwards — it writes on every request and is not rotated.

---

## 7. Adding documents after deployment

Authors drop `.md` files into `C:\inetpub\KnowledgeBase\wwwroot\content\<category>\`
and then rebuild the index:

```powershell
C:\source\it-knowledge-base\tools\Build-DocsIndex.ps1 `
    -ContentPath 'C:\inetpub\KnowledgeBase\wwwroot\content'
```

No app pool recycle is needed — markdown and `index.json` are served with
`no-cache`, so a browser refresh picks up the change.

To let authors edit without touching the server, keep the content folder in
Git and have the index build run as a scheduled task:

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\source\it-knowledge-base\tools\Build-DocsIndex.ps1" -ContentPath "C:\inetpub\KnowledgeBase\wwwroot\content"'

Register-ScheduledTask -TaskName 'KB: rebuild docs index' `
    -Trigger (New-ScheduledTaskTrigger -Daily -At 6am) `
    -Action $action -RunLevel Highest
```
