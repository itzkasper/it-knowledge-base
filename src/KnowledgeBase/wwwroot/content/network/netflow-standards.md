---
title: NetFlow and Traffic Monitoring Standards
category: Network
tags: [netflow, ipfix, prtg, monitoring, capacity]
updated: 2026-10-16
owner: Network Team
---

## Purpose

How flow export is configured across the estate, and how the dashboard's
traffic panel reads that data.

## What exports flow data

| Device class | Protocol | Export to | Sampling |
|--------------|----------|-----------|----------|
| Core routers | IPFIX | `10.20.5.11:2055` | 1:1 (unsampled) |
| Distribution switches | NetFlow v9 | `10.20.5.11:2055` | 1:1 |
| Edge firewalls | NetFlow v9 | `10.20.5.12:2055` | 1:1 |
| Access switches | none | — | — |

Access switches do not export flow. Their traffic is visible via SNMP interface
counters, which is sufficient for capacity work and much cheaper.

> [!NOTE]
> Keep flow unsampled on anything carrying WAN or internet traffic. Sampled
> flow is fine for volume trending but makes top-talker data misleading, which
> is exactly what you need it for during an incident.

## Active timeout matters

Set the active flow timeout to 60 seconds. The default on most platforms is 30
minutes, which means a long-lived transfer is reported as one enormous flow
when it finally ends, and your 5-minute graph shows a spike in the wrong
interval.

### Cisco IOS-XE

```
flow record FR-IPV4
 match ipv4 source address
 match ipv4 destination address
 match transport source-port
 match transport destination-port
 match ipv4 protocol
 collect counter bytes
 collect counter packets

flow exporter EX-PRTG
 destination 10.20.5.11
 source Loopback0
 transport udp 2055
 template data timeout 60

flow monitor FM-IPV4
 exporter EX-PRTG
 record FR-IPV4
 cache timeout active 60
 cache timeout inactive 15

interface GigabitEthernet0/0/1
 ip flow monitor FM-IPV4 input
 ip flow monitor FM-IPV4 output
```

## PRTG sensor configuration

1. Add the flow sensor to the **exporting device**, not the collector.
2. Match the sensor's port to the exporter's destination port (`2055`).
3. Set **Channel Selection** to group by the traffic classes you actually
   report on. The dashboard plots one line per channel, so a sensor with 30
   channels produces an unreadable chart.
4. Enable at least one **Toplist**. Without it, the dashboard's Top Talkers
   panel has nothing to show — PRTG only retains top-talker data when a toplist
   is defined on the sensor.

### Recommended toplists

| Toplist | Shows | Use |
|---------|-------|-----|
| Top Talkers | Busiest hosts | "Who is saturating the link right now" |
| Top Connections | Busiest host pairs | Finding a single runaway transfer |
| Top Protocols | Traffic by protocol | Capacity planning and policy checks |

## How the dashboard reads this

The front page's **Traffic by channel** panel calls PRTG's historic-data API
for the selected flow sensor and plots one line per channel.

Two behaviours worth knowing:

- A channel named **Total** is dropped when per-channel data exists. Plotting a
  total alongside its own components double-counts the same traffic and flattens
  the components against the axis.
- Past eight channels, the remainder is summed into a single **Other** series.
  The categorical palette has eight slots, and cycling colours would make two
  different channels share one colour.

## Verification

```powershell
# Is anything arriving at the collector?
netstat -an | Select-String "2055"

# On the exporter
# show flow exporter statistics
# show flow monitor FM-IPV4 cache
```

In PRTG the sensor should leave "No data" within two scan intervals of being
created. If it stays empty, the export is not arriving — check that the
exporter's source interface address is permitted by any ACL in the path, and
that the probe's Windows Firewall allows inbound 2055/UDP.

## Related

- [SNMP Configuration Baseline](#/network/snmp-baseline)
- [Triage a Down PRTG Sensor](#/runbooks/prtg-sensor-down-triage)
