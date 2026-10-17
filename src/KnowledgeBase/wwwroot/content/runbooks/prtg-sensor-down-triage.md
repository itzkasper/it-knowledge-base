---
title: Triage a Down PRTG Sensor
category: Runbooks
tags: [prtg, monitoring, snmp, troubleshooting]
updated: 2026-10-16
owner: Network Team
---

## Purpose

Work out, quickly and in a fixed order, whether a red sensor on the dashboard
means a real outage, a monitoring fault, or noise.

## Before you start

- Read access to PRTG
- The device's entry in the [Server and Device Naming Convention](#/reference/naming-convention)
  so you know what it is before you touch it

## Decide what kind of failure it is

Work top to bottom and stop at the first match.

### 1. Is it only one sensor on the device?

If every other sensor on the same device is green, the device is up and the
problem is with that one check. Go to **Sensor-level faults**.

### 2. Are all sensors on the device down?

The device or the path to it is down. Go to **Device-level faults**.

### 3. Are all devices behind one probe down?

The probe service or its network path is the problem — not the devices. Check
the PRTG probe service first; do not raise an incident per device.

```powershell
Get-Service -ComputerName prtg-probe01 -Name PRTGProbeService
Restart-Service -InputObject (Get-Service -ComputerName prtg-probe01 -Name PRTGProbeService)
```

## Sensor-level faults

| Message in PRTG | Usual cause | Action |
|-----------------|-------------|--------|
| `No such instance (SNMP error # 223)` | Interface index changed after a reboot or firmware update | Re-scan the device and recreate the sensor |
| `SNMP timeout` on one sensor only | Device CPU saturated, or the OID is slow | Raise the sensor's timeout and lower its scan rate |
| `Authentication failed` | SNMP community or v3 credentials changed | Correct the credentials on the parent device |
| `Threshold exceeded` | Genuine condition | Treat as a real alert |

Confirm the OID responds outside PRTG before changing anything:

```powershell
# From the probe server
snmpwalk -v2c -c public switch-core01 1.3.6.1.2.1.2.2.1.10
```

> [!NOTE]
> An interface index (`ifIndex`) is not stable across reboots on most switches.
> If traffic sensors break after every maintenance window, rebuild them against
> `ifName` or `ifAlias` instead of `ifIndex`.

## Device-level faults

1. Check whether the device answers at all.

   ```powershell
   Test-NetConnection -ComputerName switch-core01 -InformationLevel Detailed
   ```

2. If ICMP succeeds but SNMP fails, the agent is the problem, not the link:

   ```powershell
   Test-NetConnection -ComputerName switch-core01 -Port 161
   ```

3. If ICMP fails, check the upstream device in PRTG's dependency tree before
   declaring the device down. A failed uplink shows as dozens of down devices.

4. Confirm there is no change record covering the window before raising an
   incident.

## Escalation

| Condition | Escalate to |
|-----------|-------------|
| Core switch or router down | Network Team lead, immediately |
| Single access switch down | Network Team, within the hour |
| Monitoring fault only, service healthy | Ticket, next business day |
| Probe service down | Monitoring owner, immediately |

## Verification

The sensor returns to green and stays green across at least three scan
intervals. A sensor that flaps between up and down has not been fixed — treat
flapping as still-open and look for duplex mismatch, a failing optic, or an
undersized scan interval.

## Related

- [NetFlow and Traffic Monitoring Standards](#/network/netflow-standards)
- [SNMP Configuration Baseline](#/network/snmp-baseline)
