---
title: SNMP Configuration Baseline
category: Network
tags: [snmp, prtg, monitoring, security, baseline]
updated: 2026-10-11
owner: Network Team
---

## Purpose

The SNMP settings every managed device must carry before it is added to PRTG.

## Standard

| Setting | Value |
|---------|-------|
| Version | SNMPv3 (v2c only where v3 is unsupported) |
| Auth protocol | SHA-256 |
| Privacy protocol | AES-128 |
| Username | `prtg-monitor` |
| Access | Read-only, always |
| Allowed source | PRTG probe addresses only |
| Port | 161/UDP |
| Location string | `<site>/<room>/<rack>/<RU>` |

> [!CAUTION]
> Read-write SNMP must not be enabled on any device. PRTG never needs it, and a
> read-write community is a device takeover waiting to happen.

## Why v3

v2c sends its community string in clear text, and that string is effectively a
password for reading the whole device. Anyone on a span port, a mirrored
uplink, or a compromised access switch can read it and then read your topology,
interface names, ARP tables, and routing. Use v3 unless the device genuinely
cannot do it.

Where v2c is unavoidable:

- Use a community string unique to that device class, never `public`
- Restrict the source addresses to the probes in an ACL on the device
- Record the exception in the risk register with a replacement date

## Configuration

### Cisco IOS

```
snmp-server group PRTG-RO v3 priv read SNMP-RO access 20
snmp-server user prtg-monitor PRTG-RO v3 auth sha <AUTH_PASS> priv aes 128 <PRIV_PASS>
snmp-server view SNMP-RO iso included
snmp-server location HQ/Comms-1/RackB/U22
snmp-server contact netops@contoso.com

ip access-list standard 20
 permit 10.20.5.11
 permit 10.20.5.12
 deny   any log
```

### Windows Server

SNMP on Windows is deprecated and v2c-only. Prefer WMI or a PRTG agent sensor
for Windows hosts; use SNMP only where a third-party tool requires it.

```powershell
# Restrict to the probes, read-only
$key = 'HKLM:\SYSTEM\CurrentControlSet\Services\SNMP\Parameters'
New-ItemProperty -Path "$key\PermittedManagers" -Name '1' `
    -Value '10.20.5.11' -PropertyType String -Force
New-ItemProperty -Path "$key\ValidCommunities" -Name 'ro-community-here' `
    -Value 4 -PropertyType DWord -Force   # 4 = READ ONLY
Restart-Service SNMP
```

### Linux (net-snmp)

```
createUser prtg-monitor SHA-256 "<AUTH_PASS>" AES "<PRIV_PASS>"
rouser prtg-monitor authpriv
syslocation HQ/Comms-1/RackB/U22
syscontact netops@contoso.com
agentaddress 161
```

## Verification

From a PRTG probe server:

```powershell
# v3
snmpwalk -v3 -l authPriv -u prtg-monitor -a SHA-256 -A '<AUTH_PASS>' `
         -x AES -X '<PRIV_PASS>' switch-core01 sysDescr.0

# Expect a device description, not a timeout
```

Then in PRTG, run **Recommended Sensors** on the device and confirm it detects
interfaces. If the walk works but PRTG times out, the probe is using different
credentials than the ones you tested with — check the credential inheritance on
the parent group.

## Related

- [NetFlow and Traffic Monitoring Standards](#/network/netflow-standards)
- [Triage a Down PRTG Sensor](#/runbooks/prtg-sensor-down-triage)
