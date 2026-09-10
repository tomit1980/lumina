<#
.SYNOPSIS
  Set a Lumina user's password directly, without sending any email.

.DESCRIPTION
  The way back in when somebody is locked out and email is not available.

  WHY THIS EXISTS. Supabase's free tier sends auth email through a shared
  service capped at a couple of messages an hour. On Lumina's first day in
  production the Owner forgot their password, spent the quota on magic links,
  and hit "email rate limit exceeded" with no way in - while the dashboard's
  own recovery controls offered nothing but two more emails.

  This talks to the Auth Admin API instead, which sets the password server
  side and sends nothing. It is the same operation the dashboard would perform
  if its UI exposed one.

  NOTHING IS ECHOED OR STORED. Both the service key and the new password are
  read as PowerShell SecureStrings: they never appear on screen, never enter
  your shell history, and are not written to disk. They live in memory for the
  length of one request.

  THE SERVICE KEY BYPASSES EVERY ACCESS RULE IN THE DATABASE. It is not the
  publishable key that ships in the browser bundle. Paste it here, never into
  a file in this repository, never into a chat window, and never into a build.

.EXAMPLE
  .\scripts\set-password.ps1 -Email you@example.com

.EXAMPLE
  .\scripts\set-password.ps1 -Email you@example.com -ProjectRef nsioivydefazicxnozqw
#>
[CmdletBinding()]
param(
  # The address of the account to change. Must already exist.
  [Parameter(Mandatory = $true)]
  [string] $Email,

  # Which project. Defaults to production; pass the dev ref to work on dev.
  [string] $ProjectRef = 'eshstdmgceohizbevwll'
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell sends "Mozilla/5.0 ... WindowsPowerShell/5.1" as its
# User-Agent. Supabase's edge reads that as a browser and refuses the secret
# key outright - "Forbidden use of secret API key in browser" - which is a
# good rule catching the wrong client. Every call below therefore says what it
# actually is.
#
# The first version of this script was verified with curl, which sends
# "curl/8.x" and sailed through. The API path was proved; the script was not.
$UA = 'lumina-set-password/1 (PowerShell)'

function Read-Plain {
  param([Security.SecureString] $Secure)
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try   { [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$base = "https://$ProjectRef.supabase.co"
Write-Host "Project : $ProjectRef"
Write-Host "Account : $Email"
Write-Host ""
Write-Host "The service key is on the project's Settings -> API Keys page." -ForegroundColor DarkGray
Write-Host "It is the SECRET one (sb_secret_...), not the publishable key." -ForegroundColor DarkGray

$keySecure = Read-Host -AsSecureString "Service key (hidden)"
$key = Read-Plain $keySecure
if (-not $key) { throw "No service key given." }
if ($key -like 'sb_publishable_*') {
  throw "That is the publishable key. It cannot change a password - you need the secret one."
}

$pw1 = Read-Plain (Read-Host -AsSecureString "New password (hidden)")
$pw2 = Read-Plain (Read-Host -AsSecureString "Type it again")
if ($pw1 -ne $pw2)     { throw "The two passwords do not match. Nothing was changed." }
if ($pw1.Length -lt 8) { throw "Use at least 8 characters. Nothing was changed." }

$headers = @{ apikey = $key; Authorization = "Bearer $key"; 'Content-Type' = 'application/json' }

# Find the account. The Admin API addresses users by id, not by address, so
# this resolves one to the other rather than trusting a hand-copied UUID: a
# mistyped id changes a different person's password and says nothing about it.
#
# Paged and matched here rather than server-side. The endpoint takes a
# `filter` parameter and it looked like the obvious tool - but on this
# deployment it matched nothing at all and returned an empty list, which is
# indistinguishable from "no such account". A filter that silently matches
# nothing is worse than no filter: it turns a working lookup into a confident
# denial.
Write-Host "`nLooking up the account..."
$user = $null
$page = 1
while ($page -le 25) {
  $batch = Invoke-RestMethod -Method Get -Headers $headers -UserAgent $UA `
    -Uri "$base/auth/v1/admin/users?page=$page&per_page=200"
  $users = @($batch.users)
  if ($users.Count -eq 0) { break }
  $hit = @($users | Where-Object { $_.email -eq $Email })
  if ($hit.Count -gt 1) { throw "More than one account has that address. Refusing to guess." }
  if ($hit.Count -eq 1) { $user = $hit[0]; break }
  if ($users.Count -lt 200) { break }
  $page++
}
if (-not $user) { throw "No account with that address on $ProjectRef. Nothing was changed." }

Write-Host "Found $($user.id)"

$body = @{ password = $pw1 } | ConvertTo-Json -Compress
$null = Invoke-RestMethod -Method Put -Headers $headers -UserAgent $UA `
  -Uri "$base/auth/v1/admin/users/$($user.id)" -Body $body

# Prove it, rather than trusting a request that did not throw. A 200 says the
# API accepted the call; only a sign-in says the password actually works, and
# the difference between those two is most of what went wrong this week.
Write-Host "Password set. Verifying by signing in..."
$anonPrompt = Read-Host "Publishable key (visible; it ships in the browser bundle anyway)"
if ($anonPrompt) {
  try {
    $signIn = Invoke-RestMethod -Method Post -UserAgent $UA `
      -Headers @{ apikey = $anonPrompt; 'Content-Type' = 'application/json' } `
      -Uri "$base/auth/v1/token?grant_type=password" `
      -Body (@{ email = $Email; password = $pw1 } | ConvertTo-Json -Compress)
    if ($signIn.access_token) {
      Write-Host "`nVerified: that password signs in." -ForegroundColor Green
    } else {
      Write-Warning "The sign-in returned no token. Check the account in the dashboard."
    }
  } catch {
    Write-Warning "The password was set, but signing in with it failed: $($_.Exception.Message)"
    Write-Warning "If this account has two-factor enabled, that is expected - the first"
    Write-Warning "step succeeds and the second is a code the app asks for."
  }
} else {
  Write-Host "Skipped verification. Sign in at https://tomit1980.github.io/lumina/ to check."
}

$pw1 = $null; $pw2 = $null; $key = $null
[GC]::Collect()
