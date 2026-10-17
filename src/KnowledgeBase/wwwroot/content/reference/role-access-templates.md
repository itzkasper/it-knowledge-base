---
title: Role Access Templates
category: Reference
tags: [access, groups, onboarding, reference]
updated: 2026-10-05
owner: IT Operations
---

## Purpose

The group memberships each role gets at onboarding. Provision from this table,
never by copying an existing user's account.

## Why not copy an existing user

A copied account inherits every access grant the original picked up over years,
including the ones granted for a project that ended. Those grants then
propagate to the next copy. Within a few hires nobody can say why an account
has the access it has, and access reviews become guesswork.

## Templates

### All staff

Applied to every account regardless of role.

| Group | Grants |
|-------|--------|
| `All-Staff` | Intranet, print queues, company shares |
| `VPN-Users` | Remote access, MFA enforced |
| `M365-E3` | Licence assignment |

### Finance

| Group | Grants |
|-------|--------|
| `Finance-Staff` | Finance share, reporting portal |
| `ERP-Readers` | ERP read-only |
| `Printers-HQ-Floor2` | Floor printers |

Finance approvers additionally need `ERP-Approvers`, which requires the finance
director's written approval per person.

### Service Desk

| Group | Grants |
|-------|--------|
| `Service-Desk-Operators` | Delegated AD unlock and password reset |
| `Helpdesk-Tools` | Remote assistance, asset register write |
| `PRTG-Read` | Monitoring read access |

### Network Team

| Group | Grants |
|-------|--------|
| `Network-Admins` | Switch and firewall management |
| `PRTG-Admins` | Monitoring configuration |
| `Change-Approvers` | Network change approval |

> [!CAUTION]
> `Network-Admins` carries device configuration rights across the estate.
> Membership requires the network lead's approval and is reviewed quarterly.

## Review

Every template group is reviewed quarterly by its owner. Memberships that
cannot be justified against a current role are removed, not grandfathered.

```powershell
# Current membership of a template group
Get-ADGroupMember -Identity 'Finance-Staff' |
    Select-Object Name, SamAccountName |
    Sort-Object Name
```

## Related

- [Onboard a New Employee](#/sops/onboard-new-employee)
- [Offboard a Departing Employee](#/sops/offboard-employee)
