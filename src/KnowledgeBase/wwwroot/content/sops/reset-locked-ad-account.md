---
title: Reset a Locked Active Directory Account
category: SOPs
tags: [active-directory, accounts, service-desk]
updated: 2026-10-14
owner: Service Desk
---

## Purpose

Unlock and, if required, reset the password for a domain account that has been
locked out by the account lockout policy.

## Before you start

- Membership of `Service Desk Operators` (delegated unlock and reset rights)
- RSAT Active Directory tools, or a session on a domain controller
- An open ticket to record the action against

> [!WARNING]
> Verify the caller's identity before unlocking any account. Use the callback
> number on record in the HR system — never a number supplied during the call.

## Procedure

1. Confirm the lockout is real and find the source.

   ```powershell
   Get-ADUser jsmith -Properties LockedOut, BadLogonCount, LastBadPasswordAttempt |
       Select-Object SamAccountName, LockedOut, BadLogonCount, LastBadPasswordAttempt
   ```

2. Identify which domain controller recorded the lockout, so you know where to
   look for the source machine.

   ```powershell
   Get-ADDomainController -Filter * |
       ForEach-Object {
           Search-ADAccount -LockedOut -Server $_.HostName |
               Where-Object SamAccountName -eq 'jsmith'
       }
   ```

3. Check event ID `4740` on that domain controller's Security log. The
   **Caller Computer Name** field names the device that triggered the lockout.

4. Unlock the account.

   ```powershell
   Unlock-ADAccount -Identity jsmith
   ```

5. Only if the user cannot recall their password, force a reset:

   ```powershell
   Set-ADAccountPassword -Identity jsmith -Reset `
       -NewPassword (Read-Host -AsSecureString "New password")
   Set-ADUser -Identity jsmith -ChangePasswordAtLogon $true
   ```

6. Tell the user which device caused the lockout. The usual culprits are a
   stale mapped drive, a phone with an old mail password, or a cached
   credential in Windows Credential Manager.

## Verification

| Check | Expected result |
|-------|-----------------|
| `Get-ADUser jsmith -Properties LockedOut` | `LockedOut : False` |
| User signs in on their own device | Succeeds |
| Repeat lockout within 15 minutes | Does not occur |

If the account locks again immediately, the source device is still presenting
the old password. Clear it before closing the ticket:

```powershell
# On the user's machine
cmdkey /list
cmdkey /delete:Domain:target=fileserver01
```

## Rollback

Unlocking an account cannot be undone, and does not need to be. If a password
was reset in error, the user sets a new one at next sign-in.

## Related

- [Password and Account Lockout Policy](#/policies/password-policy)
- [Triage a Down PRTG Sensor](#/runbooks/prtg-sensor-down-triage)
