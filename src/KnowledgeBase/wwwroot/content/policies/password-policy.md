---
title: Password and Account Lockout Policy
category: Policies
tags: [security, passwords, active-directory, policy]
updated: 2026-09-28
owner: Information Security
---

## Scope

All domain accounts, service accounts and local administrator accounts on
company-managed systems.

## Requirements

| Setting | Value | Rationale |
|---------|-------|-----------|
| Minimum length | 14 characters | Length beats composition rules |
| Complexity requirement | Disabled | Encourages passphrases over `P@ssw0rd1` |
| Maximum age | None for user accounts | Forced rotation drives weaker choices |
| Banned password list | Enabled | Blocks the leaked-password corpus |
| MFA | Required for all remote access | Password alone is not sufficient |
| Lockout threshold | 10 attempts | High enough to tolerate a stale credential |
| Lockout window | 15 minutes | |
| Lockout duration | 15 minutes, auto-release | Removes most unlock tickets |
| Password reuse | Last 24 blocked | |

> [!NOTE]
> Expiry is deliberately disabled for user accounts. Mandatory rotation makes
> people pick predictable variants and write them down. Compromise response is
> a forced reset of the affected account, not a scheduled estate-wide one.

## Service accounts

- Use a **Group Managed Service Account** wherever the application supports it;
  the password is then managed by the domain and never known to anyone.
- Where a gMSA is not possible: 32 characters, random, stored in the password
  vault, rotated annually and on any team change.
- Service accounts must not be members of `Domain Admins`.
- Deny interactive sign-in for every service account.

```powershell
# Preferred: gMSA
New-ADServiceAccount -Name svc-prtg-probe `
    -DNSHostName prtg-probe01.contoso.com `
    -PrincipalsAllowedToRetrieveManagedPassword 'PRTG-Probes'
```

## When a password must be reset immediately

- Any suspicion of compromise or phishing credential entry
- An account appearing in a breach notification
- Shared knowledge of the password, however it happened
- Staff departure where a shared credential existed

## Enforcement

Settings are applied by the `Default Domain Policy` for the lockout values and
by a **Fine-Grained Password Policy** for length and history. Service accounts
sit in a separate FGPP with a longer minimum.

```powershell
Get-ADDefaultDomainPasswordPolicy
Get-ADFineGrainedPasswordPolicy -Filter * |
    Select-Object Name, MinPasswordLength, PasswordHistoryCount, Precedence
```

## Exceptions

Exceptions require Information Security approval, a documented compensating
control, and a review date no more than twelve months out. Record them in the
risk register.

## Related

- [Reset a Locked Active Directory Account](#/sops/reset-locked-ad-account)
- [Offboard a Departing Employee](#/sops/offboard-employee)
