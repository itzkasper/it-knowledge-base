---
title: Server and Device Naming Convention
category: Reference
tags: [naming, standards, reference, inventory]
updated: 2026-08-21
owner: IT Operations
---

## Format

```
<role><nn>            servers        e.g. dc01, sql02, prtg01
<class>-<site><nn>    network kit    e.g. sw-hq01, fw-br02
<site>-<type>-<nn>    endpoints      e.g. hq-lt-0184
```

NetBIOS still caps at 15 characters, so names stay short. Lowercase
everywhere — DNS is case-insensitive, but mixed case in scripts and
documentation is a steady source of mistakes.

## Server roles

| Prefix | Role |
|--------|------|
| `dc` | Domain controller |
| `fs` | File server |
| `sql` | SQL Server |
| `app` | Application server |
| `web` | Web server (IIS) |
| `prtg` | PRTG core or probe |
| `bkp` | Backup server |
| `hv` | Hyper-V host |
| `rds` | Remote Desktop host |

## Network classes

| Prefix | Class |
|--------|-------|
| `sw` | Switch |
| `rt` | Router |
| `fw` | Firewall |
| `ap` | Wireless access point |
| `ups` | UPS management card |

## Site codes

| Code | Site |
|------|------|
| `hq` | Head office |
| `br` | Branch (numbered per branch) |
| `dc` | Colocation |
| `wh` | Warehouse |

> [!WARNING]
> `dc` is both the domain-controller role prefix and the colocation site code.
> Role prefixes apply to servers and site codes to network and endpoint names,
> so the two never appear in the same position — but when scripting against
> names, match on the whole pattern, not a leading substring.

## Rules

1. Never encode the operating system version or hardware model. Both change
   while the name stays, and a `win2016` box running 2022 is worse than no
   information at all.
2. Never reuse a retired name for twelve months. Stale DNS records, monitoring
   history and certificates all outlive the server.
3. Numbers are zero-padded to two digits, so sorting works.
4. The PRTG device name must match the DNS name exactly. The dashboard groups
   SNMP sensors by device name, and a mismatch splits one device into two.

## Verification

```powershell
# Names that do not match the server pattern
Get-ADComputer -Filter { OperatingSystem -like '*Server*' } |
    Where-Object { $_.Name -notmatch '^[a-z]{2,4}\d{2}$' } |
    Select-Object Name, DNSHostName
```

## Related

- [Onboard a New Employee](#/sops/onboard-new-employee)
- [SNMP Configuration Baseline](#/network/snmp-baseline)
