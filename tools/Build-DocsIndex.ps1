<#
.SYNOPSIS
    Builds the knowledge base search index from the markdown files under
    wwwroot/content.

.DESCRIPTION
    Scans every .md file in the content folder, reads its YAML front matter,
    extracts headings and a plain-text body, and writes content/index.json.
    The website reads that one file to render the category tree and to run
    full-text search in the browser.

    Run this after adding, renaming or editing a document. Files whose name
    begins with an underscore (for example _template.md) are skipped.

    Written for Windows PowerShell 5.1, which is what Windows Server 2019
    ships with. No modules required.

.PARAMETER ContentPath
    Folder holding the markdown files. Defaults to the wwwroot/content folder
    next to this script's repository.

.PARAMETER MaxBodyChars
    How much plain text per document is kept for searching. Larger values make
    search more thorough and index.json bigger.

.PARAMETER Watch
    Keep running and rebuild whenever a file changes. Useful while authoring.

.EXAMPLE
    .\Build-DocsIndex.ps1

.EXAMPLE
    .\Build-DocsIndex.ps1 -Watch
#>
[CmdletBinding()]
param(
    [string] $ContentPath,
    [int]    $MaxBodyChars = 6000,
    [switch] $Watch
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- locate content

if (-not $ContentPath) {
    $ContentPath = Join-Path $PSScriptRoot '..\src\KnowledgeBase\wwwroot\content'
}

$ContentPath = [System.IO.Path]::GetFullPath($ContentPath)

if (-not (Test-Path -LiteralPath $ContentPath)) {
    throw "Content folder not found: $ContentPath"
}

$indexPath = Join-Path $ContentPath 'index.json'

# ------------------------------------------------------------------- front matter

function Read-FrontMatter {
    <#
        Minimal YAML: scalar values, inline lists (key: [a, b]) and block
        lists (- item). That covers title/category/tags/updated/owner, which is
        all the site reads. Returns a hashtable plus the remaining body.
    #>
    param([string] $Text)

    $result = @{
        Data = @{}
        Body = $Text
    }

    # Front matter must be the very first thing in the file.
    if ($Text -notmatch '^﻿?---\r?\n') {
        return $result
    }

    $lines = $Text -split "`r?`n"
    $end = -1

    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^---\s*$') {
            $end = $i
            break
        }
    }

    if ($end -lt 0) {
        return $result
    }

    $data = @{}
    $currentKey = $null

    for ($i = 1; $i -lt $end; $i++) {
        $line = $lines[$i]

        if ($line -match '^\s*$' -or $line -match '^\s*#') {
            continue
        }

        # Block list item, belonging to the key above it.
        if ($line -match '^\s*-\s+(.*)$' -and $currentKey) {
            $value = Remove-Quotes $matches[1]
            if ($data[$currentKey] -isnot [System.Collections.IList]) {
                $data[$currentKey] = @()
            }
            $data[$currentKey] += $value
            continue
        }

        if ($line -match '^([A-Za-z0-9_.-]+)\s*:\s*(.*)$') {
            $currentKey = $matches[1]
            $raw = $matches[2].Trim()

            if ($raw -eq '') {
                $data[$currentKey] = @()
            }
            elseif ($raw -match '^\[(.*)\]$') {
                $items = @()
                foreach ($part in ($matches[1] -split ',')) {
                    $clean = Remove-Quotes $part.Trim()
                    if ($clean -ne '') { $items += $clean }
                }
                $data[$currentKey] = $items
            }
            else {
                $data[$currentKey] = Remove-Quotes $raw
            }
        }
    }

    $bodyLines = @()
    if ($end + 1 -lt $lines.Count) {
        $bodyLines = $lines[($end + 1)..($lines.Count - 1)]
    }

    $result.Data = $data
    $result.Body = ($bodyLines -join "`n")
    return $result
}

function Remove-Quotes {
    param([string] $Value)

    $text = $Value.Trim()

    if ($text.Length -gt 1) {
        if (($text.StartsWith('"') -and $text.EndsWith('"')) -or
            ($text.StartsWith("'") -and $text.EndsWith("'"))) {
            return $text.Substring(1, $text.Length - 2)
        }
    }

    return $text
}

# ----------------------------------------------------------------- body analysis

function Get-Headings {
    <# ATX headings outside fenced code blocks. #>
    param([string] $Body)

    $headings = @()
    $inFence = $false

    foreach ($line in ($Body -split "`r?`n")) {
        if ($line -match '^\s{0,3}(```|~~~)') {
            $inFence = -not $inFence
            continue
        }
        if ($inFence) { continue }

        if ($line -match '^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$') {
            $headings += ($matches[2].Trim())
        }
    }

    return $headings
}

function Get-PlainText {
    <# Strips markdown to words, for the browser's search index. #>
    param([string] $Body, [int] $MaxChars)

    $text = $Body

    $text = [regex]::Replace($text, '(?s)```.*?```', ' ')
    $text = [regex]::Replace($text, '(?s)~~~.*?~~~', ' ')
    $text = [regex]::Replace($text, '`([^`]+)`', '$1')
    $text = [regex]::Replace($text, '!\[[^\]]*\]\([^)]*\)', ' ')
    $text = [regex]::Replace($text, '\[([^\]]+)\]\([^)]*\)', '$1')
    $text = [regex]::Replace($text, '(?m)^\s{0,3}#{1,6}\s+', '')
    $text = [regex]::Replace($text, '(?m)^\s{0,3}>\s?', '')
    $text = [regex]::Replace($text, '\[!\w+\]', '')
    $text = [regex]::Replace($text, '(?m)^\s*\[[ xX]\]\s+', '')
    $text = [regex]::Replace($text, '(?m)^\s*([-*+]|\d+[.)])\s+', '')
    # Table rules and horizontal rules carry no words worth indexing.
    $text = [regex]::Replace($text, '(?m)^[ \t]*[|:\-\s]{3,}$', ' ')
    $text = [regex]::Replace($text, '[*_~|]', ' ')
    $text = [regex]::Replace($text, '\s+', ' ')
    $text = $text.Trim()

    if ($text.Length -gt $MaxChars) {
        $text = $text.Substring(0, $MaxChars)
    }

    return $text
}

function Get-FallbackTitle {
    <# First H1, else the file name turned into words. #>
    param([string] $Body, [string] $BaseName)

    foreach ($line in ($Body -split "`r?`n")) {
        if ($line -match '^\s{0,3}#\s+(.*?)\s*#*\s*$') {
            return $matches[1].Trim()
        }
    }

    $words = ($BaseName -split '[-_]') | Where-Object { $_ -ne '' } | ForEach-Object {
        $_.Substring(0, 1).ToUpper() + $_.Substring(1)
    }

    return ($words -join ' ')
}

# ----------------------------------------------------------------------- build

function Build-Index {
    param([string] $Root, [string] $OutFile, [int] $MaxChars)

    $files = Get-ChildItem -LiteralPath $Root -Filter '*.md' -Recurse -File |
        Where-Object { -not $_.Name.StartsWith('_') } |
        Sort-Object FullName

    $documents = @()
    $warnings = @()

    foreach ($file in $files) {
        $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
        if ($null -eq $text) { $text = '' }

        $parsed = Read-FrontMatter -Text $text
        $data = $parsed.Data
        $body = $parsed.Body

        # Relative path, forward slashes, used both as the fetch path and slug.
        $relative = $file.FullName.Substring($Root.Length).TrimStart('\', '/')
        $relative = $relative -replace '\\', '/'
        $slug = ($relative -replace '\.md$', '').ToLowerInvariant()

        if ($data.ContainsKey('title') -and "$($data.title)".Trim() -ne '') {
            $title = "$($data.title)".Trim()
        }
        else {
            $title = Get-FallbackTitle -Body $body -BaseName $file.BaseName
            $warnings += "$relative has no 'title' in front matter; using '$title'."
        }

        if ($data.ContainsKey('category') -and "$($data.category)".Trim() -ne '') {
            $category = "$($data.category)".Trim()
        }
        else {
            # Fall back to the folder name, title-cased.
            $folder = Split-Path $relative -Parent
            if ($folder) {
                $leaf = ($folder -split '/')[0]
                $category = $leaf.Substring(0, 1).ToUpper() + $leaf.Substring(1)
            }
            else {
                $category = 'Uncategorised'
            }
        }

        $tags = @()
        if ($data.ContainsKey('tags')) {
            foreach ($tag in @($data.tags)) {
                if ("$tag".Trim() -ne '') { $tags += "$tag".Trim() }
            }
        }

        if ($data.ContainsKey('updated') -and "$($data.updated)".Trim() -ne '') {
            $updated = "$($data.updated)".Trim()
        }
        else {
            $updated = $file.LastWriteTime.ToString('yyyy-MM-dd')
        }

        $owner = ''
        if ($data.ContainsKey('owner')) { $owner = "$($data.owner)".Trim() }

        $documents += [ordered] @{
            slug     = $slug
            path     = $relative
            title    = $title
            category = $category
            tags     = $tags
            updated  = $updated
            owner    = $owner
            headings = @(Get-Headings -Body $body)
            body     = Get-PlainText -Body $body -MaxChars $MaxChars
        }
    }

    $index = [ordered] @{
        generated = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        count     = $documents.Count
        documents = $documents
    }

    # -Compress keeps the file small; it is fetched on every page load.
    $json = $index | ConvertTo-Json -Depth 6 -Compress

    # Write without a BOM: a BOM ahead of JSON breaks strict parsers.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutFile, $json, $utf8NoBom)

    return [pscustomobject] @{
        Count    = $documents.Count
        Bytes    = (Get-Item -LiteralPath $OutFile).Length
        Warnings = $warnings
    }
}

# ------------------------------------------------------------------------- run

function Invoke-Build {
    $result = Build-Index -Root $ContentPath -OutFile $indexPath -MaxChars $MaxBodyChars

    foreach ($warning in $result.Warnings) {
        Write-Warning $warning
    }

    $size = [math]::Round($result.Bytes / 1KB, 1)
    Write-Host ("Indexed {0} document(s) -> {1} ({2} KB)" -f `
        $result.Count, $indexPath, $size) -ForegroundColor Green

    return $result
}

Write-Host "Content folder: $ContentPath"
$null = Invoke-Build

if ($Watch) {
    Write-Host 'Watching for changes. Press Ctrl+C to stop.' -ForegroundColor Cyan

    # Polling rather than FileSystemWatcher: it survives editors that write via
    # a temp file and rename, which would otherwise fire several events at once.
    $previous = ''

    while ($true) {
        Start-Sleep -Seconds 2

        $stamp = (Get-ChildItem -LiteralPath $ContentPath -Filter '*.md' -Recurse -File |
            Where-Object { -not $_.Name.StartsWith('_') } |
            Sort-Object FullName |
            ForEach-Object { "$($_.FullName)|$($_.LastWriteTimeUtc.Ticks)|$($_.Length)" }
        ) -join "`n"

        if ($previous -ne '' -and $stamp -ne $previous) {
            Write-Host ("[{0}] change detected" -f (Get-Date -Format 'HH:mm:ss'))
            try {
                $null = Invoke-Build
            }
            catch {
                Write-Warning "Rebuild failed: $($_.Exception.Message)"
            }
        }

        $previous = $stamp
    }
}
