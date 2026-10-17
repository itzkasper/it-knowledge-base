---
title: Offboard a Departing Employee
category: SOPs
tags: [offboarding, active-directory, security, accounts]
updated: 2026-10-02
owner: IT Operations
---

## Purpose

Revoke access, preserve data, and recover equipment when someone leaves, with a
record that each step was completed.

## Before you start

- A **Leaver Notification** from HR with the last working day and time
- The manager's instruction on who inherits mailbox and file access
- Legal hold status for the account, if any

> [!CAUTION]
> Never delete a leaver's mailbox or home directory on the last day. Retention
> obligations usually require the data to survive the account. Disable first,
> delete only after the retention window.

## Procedure

### On the last working day, at the agreed time

1. Disable the account and revoke active sessions.

   ```powershell
   Disable-ADAccount -Identity jsmith
   Set-ADUser -Identity jsmith -Description "Leaver $(Get-Date -Format 'yyyy-MM-dd')"
   ```

2. Revoke Microsoft 365 refresh tokens so existing sessions die immediately —
   disabling the account alone does not end a signed-in session.

   ```powershell
   Revoke-MgUserSignInSession -UserId jsmith@contoso.com
   ```

3. Move the account to the leavers OU so it drops out of the staff policies.

   ```powershell
   Get-ADUser jsmith |
       Move-ADObject -TargetPath 'OU=Leavers,OU=Users,DC=contoso,DC=com'
   ```

4. Remove group memberships, keeping a record first.

   ```powershell
   $groups = (Get-ADUser jsmith -Properties MemberOf).MemberOf
   $groups | Out-File "\\fileserver01\IT\Leavers\jsmith-groups.txt"

   $groups | ForEach-Object {
       Remove-ADGroupMember -Identity $_ -Members jsmith -Confirm:$false
   }
   ```

5. Convert the mailbox to shared and grant the nominated colleague access.
6. Remove the licence only after the mailbox conversion has completed.

### Within five working days

- [ ] Recover laptop, phone, tokens, keys and access cards
- [ ] Wipe and re-image the device
- [ ] Transfer file ownership of personal drive contents to the manager
- [ ] Remove from on-call rotas, distribution lists and shared mailboxes
- [ ] Remove from third-party SaaS applications
- [ ] Close the asset register entries

## Verification

| Check | Expected result |
|-------|-----------------|
| Sign-in attempt | Fails |
| `Get-ADUser jsmith -Properties Enabled, MemberOf` | Disabled, no groups |
| VPN connection attempt | Rejected |
| Mail sent to the address | Delivered to shared mailbox |
| Asset register | No open assignments |

## Rollback

If a departure is reversed within 30 days, re-enable the account, restore the
group memberships from the saved list, and convert the mailbox back:

```powershell
Enable-ADAccount -Identity jsmith
Get-Content "\\fileserver01\IT\Leavers\jsmith-groups.txt" | ForEach-Object {
    Add-ADGroupMember -Identity $_ -Members jsmith
}
```

## Related

- [Onboard a New Employee](#/sops/onboard-new-employee)
- [Password and Account Lockout Policy](#/policies/password-policy)
