---
title: Onboard a New Employee
category: SOPs
tags: [onboarding, active-directory, microsoft-365, provisioning]
updated: 2026-10-09
owner: IT Operations
---

## Purpose

Provision accounts, licences, hardware and access for a new starter, so they
can work on day one.

## Before you start

- A completed **New Starter Request** from HR, including start date, job title,
  manager and cost centre
- The access template for the role (see [Role Access Templates](#/reference/role-access-templates))
- An available Microsoft 365 licence

> [!NOTE]
> Begin three business days before the start date. Hardware imaging and licence
> propagation are the two steps that most often run late.

## Procedure

### 1. Create the directory account

```powershell
$first = 'Jane'
$last  = 'Smith'
$sam   = ($first.Substring(0,1) + $last).ToLower()

New-ADUser `
    -Name "$first $last" `
    -GivenName $first -Surname $last `
    -SamAccountName $sam `
    -UserPrincipalName "$sam@contoso.com" `
    -Path 'OU=Staff,OU=Users,DC=contoso,DC=com' `
    -Title 'Financial Analyst' `
    -Department 'Finance' `
    -Manager 'CN=Alex Doe,OU=Staff,OU=Users,DC=contoso,DC=com' `
    -AccountPassword (Read-Host -AsSecureString 'Initial password') `
    -ChangePasswordAtLogon $true `
    -Enabled $true
```

### 2. Add group memberships

Use the role template rather than copying an existing user — copied accounts
accumulate access that nobody can later justify.

```powershell
'Finance-Staff', 'VPN-Users', 'Printers-HQ-Floor2' | ForEach-Object {
    Add-ADGroupMember -Identity $_ -Members $sam
}
```

### 3. Assign licences and mailbox

1. Wait for directory sync, or force it from the sync server:

   ```powershell
   Start-ADSyncSyncCycle -PolicyType Delta
   ```

2. Assign the licence group in Microsoft 365 admin center.
3. Confirm the mailbox exists before continuing — licence assignment is
   asynchronous and can take up to 30 minutes.

### 4. Prepare hardware

- [ ] Image the device from the current Windows task sequence
- [ ] Join to the domain and confirm it lands in the right OU
- [ ] Enable BitLocker and verify the recovery key escrowed to AD
- [ ] Install the role software bundle
- [ ] Record the asset tag against the user in the asset register

### 5. Hand over

Provide the welcome sheet with the username, the first-sign-in steps, and the
service desk contact details. Walk the user through MFA enrolment in person if
they are on site.

## Verification

| Check | Expected result |
|-------|-----------------|
| Sign in to the new device | Succeeds, prompts for password change |
| `Get-ADUser $sam -Properties MemberOf` | All template groups present |
| Send and receive a test email | Delivered both ways |
| MFA enrolment | Completed |
| BitLocker recovery key in AD | Present |

## Rollback

If a start date is cancelled, disable rather than delete the account for 30
days, then remove it:

```powershell
Disable-ADAccount -Identity $sam
Set-ADUser -Identity $sam -Description "Start cancelled $(Get-Date -Format 'yyyy-MM-dd')"
```

## Related

- [Offboard a Departing Employee](#/sops/offboard-employee)
- [Server and Device Naming Convention](#/reference/naming-convention)
