& {
    $ErrorActionPreference = "Stop"
    Set-StrictMode -Version 2

    $previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
    $temporaryRoot = $null
    $lifecycleLease = $null
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $releaseRoot = "https://github.com/rigyn/rigyn/releases"
        $releaseTagPattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
        $rigynNetworkTimeoutMilliseconds = 300000
        $rigynNetworkMaximumAttempts = 3
        $rigynNetworkRetryBaseMilliseconds = 100
        $rigynNetworkRetryMaximumMilliseconds = 1000
        $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        if ($architecture -eq [Runtime.InteropServices.Architecture]::X64) {
            $arch = "x64"
        } elseif ($architecture -eq [Runtime.InteropServices.Architecture]::Arm64) {
            $arch = "arm64"
        } else {
            throw "rigyn install: standalone releases support x64 and arm64"
        }
        $tarCommands = @(Get-Command tar.exe -CommandType Application -ErrorAction SilentlyContinue)
        if ($tarCommands.Count -eq 0) {
            throw "rigyn install: tar.exe is required to extract the standalone release"
        }
        $tarCommand = $tarCommands[0]

        $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("rigyn-install-" + [Guid]::NewGuid().ToString("N"))
        [void](New-Item -ItemType Directory -Path $temporaryRoot)

        function Test-rigynSecureAssetUri([Uri]$Uri) {
            return (
                $Uri.IsAbsoluteUri -and
                $Uri.Scheme -ieq "https" -and
                [string]::IsNullOrEmpty($Uri.UserInfo) -and
                [string]::IsNullOrEmpty($Uri.Fragment)
            )
        }

        function Test-rigynTransientHttpStatus([int]$StatusCode) {
            return (
                $StatusCode -in @(408, 425, 429) -or
                ($StatusCode -ge 500 -and $StatusCode -le 599)
            )
        }

        function Get-rigynRetryDelayMilliseconds($Response, [int]$Attempt) {
            [int]$fallback = [Math]::Min(
                $rigynNetworkRetryMaximumMilliseconds,
                $rigynNetworkRetryBaseMilliseconds * [Math]::Pow(2, $Attempt - 1)
            )
            if ($null -eq $Response) {
                return $fallback
            }
            $retryAfter = [string]$Response.Headers["Retry-After"]
            if ([string]::IsNullOrEmpty($retryAfter)) {
                return $fallback
            }
            [double]$requestedMilliseconds = -1
            [long]$seconds = 0
            if ($retryAfter -match '^(0|[1-9][0-9]*)$' -and
                [long]::TryParse($retryAfter, [ref]$seconds)) {
                if ($seconds -ge [Math]::Ceiling($rigynNetworkRetryMaximumMilliseconds / 1000.0)) {
                    $requestedMilliseconds = $rigynNetworkRetryMaximumMilliseconds
                } else {
                    $requestedMilliseconds = $seconds * 1000
                }
            } else {
                $retryAt = [DateTimeOffset]::MinValue
                if ([DateTimeOffset]::TryParseExact(
                    $retryAfter,
                    "r",
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::AssumeUniversal,
                    [ref]$retryAt
                )) {
                    $requestedMilliseconds = [Math]::Max(
                        0,
                        ($retryAt - [DateTimeOffset]::UtcNow).TotalMilliseconds
                    )
                }
            }
            if ($requestedMilliseconds -lt 0) {
                return $fallback
            }
            return [int][Math]::Max(
                $fallback,
                [Math]::Min($requestedMilliseconds, $rigynNetworkRetryMaximumMilliseconds)
            )
        }

        function Get-rigynWebResponse([Uri]$currentUri) {
            $timer = [Diagnostics.Stopwatch]::StartNew()
            for ([int]$attempt = 1; $attempt -le $rigynNetworkMaximumAttempts; $attempt += 1) {
                $request = $null
                $response = $null
                [long]$remainingMilliseconds = $rigynNetworkTimeoutMilliseconds - $timer.ElapsedMilliseconds
                if ($remainingMilliseconds -lt 1) {
                    throw "rigyn install: network request timed out"
                }
                try {
                    $request = [Net.WebRequest]::Create($currentUri)
                    [int]$requestTimeout = [Math]::Max([long]1, $remainingMilliseconds)
                    $request.Timeout = $requestTimeout
                    if ($request -is [Net.HttpWebRequest]) {
                        $request.UserAgent = "rigyn-bootstrap"
                        $request.AllowAutoRedirect = $false
                        $request.ReadWriteTimeout = $requestTimeout
                    }
                    $response = $request.GetResponse()
                } catch [Net.WebException] {
                    $response = $_.Exception.Response
                    $statusCode = if ($response -is [Net.HttpWebResponse]) {
                        [int]$response.StatusCode
                    } else {
                        $null
                    }
                    $retryable = $null -eq $response -or
                        ($null -ne $statusCode -and (Test-rigynTransientHttpStatus $statusCode))
                    if (-not $retryable -or $attempt -ge $rigynNetworkMaximumAttempts) {
                        if ($null -ne $response) {
                            return $response
                        }
                        throw
                    }
                    $delayMilliseconds = Get-rigynRetryDelayMilliseconds $response $attempt
                    $remainingMilliseconds = $rigynNetworkTimeoutMilliseconds - $timer.ElapsedMilliseconds
                    if ($delayMilliseconds -ge $remainingMilliseconds) {
                        if ($null -ne $response) {
                            return $response
                        }
                        throw
                    }
                    if ($null -ne $response) {
                        $response.Dispose()
                        $response = $null
                    }
                    Start-Sleep -Milliseconds $delayMilliseconds
                    continue
                }
                if ($response -is [Net.HttpWebResponse] -and
                    (Test-rigynTransientHttpStatus ([int]$response.StatusCode)) -and
                    $attempt -lt $rigynNetworkMaximumAttempts) {
                    $delayMilliseconds = Get-rigynRetryDelayMilliseconds $response $attempt
                    $remainingMilliseconds = $rigynNetworkTimeoutMilliseconds - $timer.ElapsedMilliseconds
                    if ($delayMilliseconds -lt $remainingMilliseconds) {
                        $response.Dispose()
                        $response = $null
                        Start-Sleep -Milliseconds $delayMilliseconds
                        continue
                    }
                }
                return $response
            }
            throw "rigyn install: network request failed"
        }

        function Get-rigynAsset([string]$Uri, [string]$Destination, [long]$MaximumBytes) {
            $response = $null
            $inputStream = $null
            $outputStream = $null
            try {
                $currentUri = $null
                if (-not [Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$currentUri) -or
                    -not (Test-rigynSecureAssetUri $currentUri)) {
                    throw "rigyn install: asset URL must use HTTPS"
                }
                [int]$redirectCount = 0
                while ($true) {
                    $response = Get-rigynWebResponse $currentUri
                    if ($response -is [Net.HttpWebResponse]) {
                        $statusCode = [int]$response.StatusCode
                        if ($statusCode -in @(301, 302, 303, 307, 308)) {
                            if ($redirectCount -ge 5) {
                                throw "rigyn install: asset download exceeded its redirect limit"
                            }
                            $location = [string]$response.Headers["Location"]
                            if ([string]::IsNullOrWhiteSpace($location)) {
                                throw "rigyn install: asset redirect has no location"
                            }
                            $nextUri = New-Object Uri($currentUri, $location)
                            if (-not (Test-rigynSecureAssetUri $nextUri)) {
                                throw "rigyn install: redirected asset URL must use HTTPS"
                            }
                            $response.Dispose()
                            $response = $null
                            $currentUri = $nextUri
                            $redirectCount += 1
                            continue
                        }
                        if ($statusCode -lt 200 -or $statusCode -ge 300) {
                            throw "rigyn install: asset download returned HTTP $statusCode"
                        }
                    }
                    if ($null -ne $response.ResponseUri -and
                        -not (Test-rigynSecureAssetUri $response.ResponseUri)) {
                        throw "rigyn install: downloaded asset URL must use HTTPS"
                    }
                    break
                }
                $declaredLength = [long]$response.ContentLength
                if ($declaredLength -eq 0 -or $declaredLength -gt $MaximumBytes) {
                    throw "rigyn install: downloaded asset has an invalid size: $([IO.Path]::GetFileName($Destination))"
                }
                $inputStream = $response.GetResponseStream()
                if ($null -eq $inputStream) {
                    throw "rigyn install: downloaded asset has no response body: $([IO.Path]::GetFileName($Destination))"
                }
                $outputStream = [IO.File]::Open(
                    $Destination,
                    [IO.FileMode]::CreateNew,
                    [IO.FileAccess]::Write,
                    [IO.FileShare]::None
                )
                $buffer = New-Object byte[] 65536
                [long]$totalBytes = 0
                while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    if ($totalBytes + $read -gt $MaximumBytes) {
                        throw "rigyn install: downloaded asset exceeds its size limit: $([IO.Path]::GetFileName($Destination))"
                    }
                    $outputStream.Write($buffer, 0, $read)
                    $totalBytes += $read
                }
                if ($totalBytes -lt 1) {
                    throw "rigyn install: downloaded asset is empty: $([IO.Path]::GetFileName($Destination))"
                }
            } catch {
                if ($null -ne $outputStream) {
                    $outputStream.Dispose()
                    $outputStream = $null
                }
                Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
                throw
            } finally {
                if ($null -ne $outputStream) { $outputStream.Dispose() }
                if ($null -ne $inputStream) { $inputStream.Dispose() }
                if ($null -ne $response) { $response.Dispose() }
            }
        }

        function Test-rigynScaffoldDestination([string]$Path, [string]$Label) {
            $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) {
                return $false
            }
            if (-not ($item -is [IO.FileInfo]) -or $item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "rigyn install: $Label must be a regular file: $Path"
            }
            return $true
        }

        function Get-rigynLatestRedirectTag([string]$Uri) {
            $currentUri = $null
            if (-not [Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$currentUri) -or
                -not (Test-rigynSecureAssetUri $currentUri)) {
                throw "rigyn install: latest-release URL must use HTTPS"
            }
            for ([int]$redirectCount = 0; $redirectCount -le 5; $redirectCount += 1) {
                $response = $null
                try {
                    $response = Get-rigynWebResponse $currentUri
                    if (-not ($response -is [Net.HttpWebResponse]) -or
                        [int]$response.StatusCode -notin @(301, 302, 303, 307, 308)) {
                        throw "rigyn install: GitHub returned an unexpected latest-release response"
                    }
                    $location = [string]$response.Headers["Location"]
                    if ([string]::IsNullOrWhiteSpace($location)) {
                        throw "rigyn install: latest-release redirect has no location"
                    }
                    $nextUri = New-Object Uri($currentUri, $location)
                    if (-not (Test-rigynSecureAssetUri $nextUri)) {
                        throw "rigyn install: latest-release redirect must use HTTPS"
                    }
                    $tagPrefix = "/rigyn/rigyn/releases/tag/"
                    if ([String]::Equals($nextUri.Host, "github.com", [StringComparison]::OrdinalIgnoreCase) -and
                        $nextUri.IsDefaultPort -and
                        [string]::IsNullOrEmpty($nextUri.Query) -and
                        $nextUri.AbsolutePath.StartsWith($tagPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                        $tag = [Uri]::UnescapeDataString($nextUri.AbsolutePath.Substring($tagPrefix.Length))
                        if ($tag -match $releaseTagPattern) {
                            return $tag
                        }
                        throw "rigyn install: GitHub returned an invalid latest-release tag"
                    }
                    if ($redirectCount -ge 5) {
                        throw "rigyn install: latest-release lookup exceeded its redirect limit"
                    }
                    $currentUri = $nextUri
                } finally {
                    if ($null -ne $response) { $response.Dispose() }
                }
            }
            throw "rigyn install: could not resolve the latest GitHub release"
        }

        $latestReleaseApi = "https://api.github.com/repos/rigyn/rigyn/releases/latest"
        $latestReleasePath = Join-Path $temporaryRoot "latest-release.json"
        $tag = $null
        try {
            Get-rigynAsset $latestReleaseApi $latestReleasePath 1048576
        } catch {
            $tag = Get-rigynLatestRedirectTag "$releaseRoot/latest"
        }
        if ($null -eq $tag) {
            $release = [IO.File]::ReadAllText($latestReleasePath) | ConvertFrom-Json
            $tag = [string]$release.tag_name
            if ($release.draft -ne $false -or $release.prerelease -ne $false -or
                $tag -notmatch $releaseTagPattern) {
                throw "rigyn install: GitHub returned invalid latest-release metadata"
            }
        }
        $version = $tag.Substring(1)

        function Get-rigynLifecycleOwner([string]$Path, [string]$InstallRoot) {
            $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) {
                return $null
            }
            if ($item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                $item.Length -gt 16384) {
                return $null
            }
            try {
                $owner = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
            } catch {
                return $null
            }
            [long]$ownerPid = 0
            [long]$ownerCreatedAt = -1
            try {
                $names = @($owner.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
                $expectedNames = @("createdAt", "installRoot", "pid", "schemaVersion", "token")
                $valid = (
                    ($names -join "`n") -ceq ($expectedNames -join "`n") -and
                    $owner.schemaVersion -eq 1 -and
                    [long]::TryParse([string]$owner.pid, [ref]$ownerPid) -and
                    $ownerPid -gt 0 -and
                    [string]$owner.token -match '^[a-f0-9]{32}$' -and
                    [long]::TryParse([string]$owner.createdAt, [ref]$ownerCreatedAt) -and
                    $ownerCreatedAt -ge 0 -and
                    [string]::Equals(
                        [IO.Path]::GetFullPath([string]$owner.installRoot),
                        [IO.Path]::GetFullPath($InstallRoot),
                        [StringComparison]::OrdinalIgnoreCase
                    )
                )
            } catch {
                $valid = $false
            }
            if (-not $valid) {
                return $null
            }
            return $owner
        }

        function Enter-rigynLifecycle([string]$InstallRoot) {
            $resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
            $path = "$resolvedRoot.lifecycle.lock"
            $token = [Guid]::NewGuid().ToString("N")
            $createdAt = [long]([DateTime]::UtcNow - [DateTime]"1970-01-01").TotalMilliseconds
            $contents = (([ordered]@{
                schemaVersion = 1
                pid = $PID
                token = $token
                createdAt = $createdAt
                installRoot = $resolvedRoot
            } | ConvertTo-Json -Compress) + [Environment]::NewLine)
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while ($true) {
                $stream = $null
                try {
                    $stream = [IO.File]::Open(
                        $path,
                        [IO.FileMode]::CreateNew,
                        [IO.FileAccess]::Write,
                        [IO.FileShare]::None
                    )
                    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($contents)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                    return [PSCustomObject]@{
                        Path = $path
                        Token = $token
                    }
                } catch [IO.IOException] {
                    $snapshot = $null
                    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
                    if ($null -eq $item) {
                        continue
                    }
                    if (-not $item.PSIsContainer -and
                        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
                        $item.Length -le 16384) {
                        try {
                            $snapshot = [IO.File]::ReadAllText($path)
                        } catch {
                            $snapshot = $null
                        }
                    }
                    $owner = Get-rigynLifecycleOwner $path $resolvedRoot
                    $stale = if ($null -eq $owner) {
                        ([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalMinutes -gt 5
                    } else {
                        $null -eq (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue)
                    }
                    if ($stale -and $null -ne $snapshot) {
                        $quarantine = "$path.stale-$PID-$([Guid]::NewGuid().ToString("N"))"
                        try {
                            Move-Item -LiteralPath $path -Destination $quarantine
                            $quarantined = [IO.File]::ReadAllText($quarantine)
                            if ($quarantined -ceq $snapshot) {
                                Remove-Item -LiteralPath $quarantine -Force
                                continue
                            }
                            if (-not (Test-Path -LiteralPath $path)) {
                                Move-Item -LiteralPath $quarantine -Destination $path
                            }
                        } catch {
                            if ((Test-Path -LiteralPath $quarantine) -and
                                -not (Test-Path -LiteralPath $path)) {
                                Move-Item -LiteralPath $quarantine -Destination $path -ErrorAction SilentlyContinue
                            }
                        }
                    }
                    if ([DateTime]::UtcNow -ge $deadline) {
                        throw "rigyn install: timed out waiting for another rigyn lifecycle operation at $resolvedRoot"
                    }
                    Start-Sleep -Milliseconds 50
                } finally {
                    if ($null -ne $stream) {
                        $stream.Dispose()
                    }
                }
            }
        }

        function Exit-rigynLifecycle($Lease) {
            if ($null -eq $Lease) {
                return
            }
            $item = Get-Item -LiteralPath $Lease.Path -Force -ErrorAction SilentlyContinue
            if ($null -eq $item -or $item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                $item.Length -gt 16384) {
                return
            }
            try {
                $owner = [IO.File]::ReadAllText($Lease.Path) | ConvertFrom-Json
                if ([string]$owner.token -ceq [string]$Lease.Token) {
                    Remove-Item -LiteralPath $Lease.Path -Force
                }
            } catch {
                # Keep a lock whose ownership can no longer be proven.
            }
        }

        function Get-rigynRuntimeLease([IO.FileSystemInfo]$Item) {
            if ($null -eq $Item -or $Item.PSIsContainer -or
                ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                $Item.Length -gt 16384 -or
                $Item.Name -cnotmatch '\A[a-f0-9]{32}\.json\z') {
                return $null
            }
            try {
                $contents = [IO.File]::ReadAllText($Item.FullName)
                $lease = $contents | ConvertFrom-Json
                [int]$leasePid = 0
                [long]$createdAt = -1
                $names = @($lease.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
                $expectedNames = @("createdAt", "installationId", "lease", "pid", "schemaVersion")
                $valid = (
                    ($names -join "`n") -ceq ($expectedNames -join "`n") -and
                    $lease.schemaVersion -eq 1 -and
                    [int]::TryParse([string]$lease.pid, [ref]$leasePid) -and
                    $leasePid -gt 0 -and
                    [string]$lease.lease -cmatch '\A[a-f0-9]{32}\z' -and
                    [string]::Equals($Item.Name, "$([string]$lease.lease).json", [StringComparison]::Ordinal) -and
                    [long]::TryParse([string]$lease.createdAt, [ref]$createdAt) -and
                    $createdAt -ge 0 -and
                    [string]$lease.installationId -cmatch '\A[a-f0-9]{32}\z'
                )
                if (-not $valid) {
                    return $null
                }
                return [PSCustomObject]@{
                    Contents = $contents
                    Pid = $leasePid
                }
            } catch {
                return $null
            }
        }

        function Test-rigynRecoveryDirectory([string]$Path, [string]$Label) {
            $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) {
                return $false
            }
            if (-not $item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "rigyn install: $Label is unsafe: $Path"
            }
            return $true
        }

        function Test-rigynRecoveryFile([string]$Path, [string]$Label, [long]$MaximumBytes) {
            $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) {
                return $false
            }
            if ($item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                $item.Length -gt $MaximumBytes) {
                throw "rigyn install: $Label is unsafe: $Path"
            }
            return $true
        }

        function Remove-rigynSafeRecoveryTree([string]$Path) {
            foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force)) {
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    if ($item.PSIsContainer) {
                        [IO.Directory]::Delete($item.FullName)
                    } else {
                        Remove-Item -LiteralPath $item.FullName -Force
                    }
                } elseif ($item.PSIsContainer) {
                    Remove-rigynSafeRecoveryTree $item.FullName
                } else {
                    Remove-Item -LiteralPath $item.FullName -Force
                }
            }
            Remove-Item -LiteralPath $Path -Force
        }

        function Remove-rigynRecoveryTree([string]$Path, [string]$Parent, [string]$Prefix) {
            if (-not (Test-Path -LiteralPath $Path)) {
                return
            }
            $resolvedParent = [IO.Path]::GetFullPath($Parent)
            $candidateParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
            $candidateName = [IO.Path]::GetFileName($Path)
            if (-not [String]::Equals($resolvedParent, $candidateParent, [StringComparison]::OrdinalIgnoreCase) -or
                -not $candidateName.StartsWith($Prefix, [StringComparison]::Ordinal)) {
                throw "rigyn install: recovery path is outside its managed directory: $Path"
            }
            [void](Test-rigynRecoveryDirectory $Path "recovery directory")
            Remove-rigynSafeRecoveryTree $Path
        }

        function Repair-rigynInterruptedStandaloneUninstall([string]$InstallRoot) {
            $resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
            $recordPath = $resolvedRoot + ".uninstall.json"
            $temporaryRecord = $recordPath + ".tmp"
            $parent = [IO.Path]::GetDirectoryName($resolvedRoot)
            $rootName = [IO.Path]::GetFileName($resolvedRoot)
            $tombstonePrefix = $rootName + ".uninstalling-"
            $recordExists = Test-rigynRecoveryFile $recordPath "standalone uninstall transaction" 16384
            if (Test-Path -LiteralPath $temporaryRecord) {
                [void](Test-rigynRecoveryFile $temporaryRecord "standalone uninstall temporary transaction" 16384)
                if (-not $recordExists) {
                    throw "rigyn install: standalone uninstall temporary transaction exists without its recovery record: $temporaryRecord"
                }
                Remove-Item -LiteralPath $temporaryRecord -Force
            }
            $tombstones = @(
                Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name.StartsWith($tombstonePrefix, [StringComparison]::Ordinal) }
            )
            if (-not $recordExists) {
                if ($tombstones.Count -gt 0) {
                    throw "rigyn install: standalone uninstall tombstone exists without its recovery record: $($tombstones[0].FullName)"
                }
                return
            }
            try {
                $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json
            } catch {
                throw "rigyn install: standalone uninstall transaction is invalid: $recordPath"
            }
            $names = @($record.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
            $expectedNames = @("distribution", "installRoot", "phase", "product", "schemaVersion", "tokenFile", "tokenSha256", "tombstone")
            try {
                $valid = (
                    ($names -join "`n") -ceq ($expectedNames -join "`n") -and
                    [string]$record.product -ceq "rigyn" -and
                    $record.schemaVersion -eq 1 -and
                    [string]$record.distribution -ceq "standalone" -and
                    [string]$record.phase -cmatch '\A(prepared|isolated|removed)\z' -and
                    [string]$record.tokenFile -cmatch '\A\.standalone-uninstall-[a-f0-9]{64}\z' -and
                    [string]$record.tokenSha256 -cmatch '\A[a-f0-9]{64}\z' -and
                    [String]::Equals([IO.Path]::GetFullPath([string]$record.installRoot), $resolvedRoot, [StringComparison]::OrdinalIgnoreCase)
                )
                $resolvedTombstone = [IO.Path]::GetFullPath([string]$record.tombstone)
                $valid = $valid -and
                    [String]::Equals([IO.Path]::GetDirectoryName($resolvedTombstone), $parent, [StringComparison]::OrdinalIgnoreCase) -and
                    [IO.Path]::GetFileName($resolvedTombstone).StartsWith($tombstonePrefix, [StringComparison]::Ordinal)
            } catch {
                $valid = $false
            }
            if (-not $valid) {
                throw "rigyn install: standalone uninstall transaction is invalid: $recordPath"
            }
            foreach ($candidate in $tombstones) {
                if (-not [String]::Equals($candidate.FullName, $resolvedTombstone, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "rigyn install: unexpected standalone uninstall tombstone: $($candidate.FullName)"
                }
            }
            $rootExists = Test-rigynRecoveryDirectory $resolvedRoot "interrupted standalone uninstall root"
            $tombstoneExists = Test-rigynRecoveryDirectory $resolvedTombstone "interrupted standalone uninstall tombstone"
            if ($rootExists -and $tombstoneExists) {
                throw "rigyn install: interrupted standalone uninstall has both active and tombstone roots"
            }
            if (-not $rootExists -and -not $tombstoneExists) {
                Remove-Item -LiteralPath $recordPath -Force
                return
            }
            $ownedRoot = if ($tombstoneExists) { $resolvedTombstone } else { $resolvedRoot }
            if (Test-Path -LiteralPath (Join-Path $ownedRoot ".installation.json")) {
                throw "rigyn install: interrupted standalone uninstall belongs to a source-built installation"
            }
            $tokenPath = Join-Path $ownedRoot ([string]$record.tokenFile)
            [void](Test-rigynRecoveryFile $tokenPath "standalone uninstall ownership token" 128)
            $tokenHash = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $tokenPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($tokenHash -cne [string]$record.tokenSha256) {
                throw "rigyn install: standalone uninstall ownership token changed"
            }
            if ($tombstoneExists) {
                Move-Item -LiteralPath $resolvedTombstone -Destination $resolvedRoot
                $tokenPath = Join-Path $resolvedRoot ([string]$record.tokenFile)
            }
            Remove-Item -LiteralPath $tokenPath -Force
            Remove-Item -LiteralPath $recordPath -Force
        }

        function Write-rigynInstallTransaction([string]$Path, $Record, [string]$Phase) {
            $temporaryRecord = $Path + ".tmp"
            try {
                $Record.phase = $Phase
                $contents = (($Record | ConvertTo-Json -Compress) + [Environment]::NewLine)
                [IO.File]::WriteAllText($temporaryRecord, $contents, (New-Object Text.UTF8Encoding($false)))
                Move-Item -LiteralPath $temporaryRecord -Destination $Path -Force
            } finally {
                Remove-Item -LiteralPath $temporaryRecord -Force -ErrorAction SilentlyContinue
            }
        }

        function Repair-rigynInterruptedInstall(
            [string]$RuntimeRoot,
            [string]$LauncherDirectory,
            [string]$Launcher,
            [string]$ManagedLauncherPattern,
            [string]$Architecture
        ) {
            $recordPath = Join-Path $RuntimeRoot ".rigyn-install-transaction.json"
            $temporaryRecord = $recordPath + ".tmp"
            $recordExists = Test-rigynRecoveryFile $recordPath "standalone runtime transaction" 16384
            if (Test-Path -LiteralPath $temporaryRecord) {
                [void](Test-rigynRecoveryFile $temporaryRecord "standalone runtime temporary transaction" 16384)
                if (-not $recordExists) {
                    throw "rigyn install: standalone runtime temporary transaction exists without its recovery record: $temporaryRecord"
                }
                Remove-Item -LiteralPath $temporaryRecord -Force
            }
            if (-not $recordExists) {
                $runtimeResidue = @(Get-ChildItem -LiteralPath $RuntimeRoot -Force | Where-Object {
                    $_.Name.StartsWith(".rigyn-stage-", [StringComparison]::Ordinal) -or
                    $_.Name.StartsWith(".rigyn-backup-", [StringComparison]::Ordinal)
                })
                $launcherResidue = @(Get-ChildItem -LiteralPath $LauncherDirectory -Force | Where-Object {
                    $_.Name -cmatch '\A\.rigyn-[a-f0-9]{32}\.cmd(?:\.previous)?\z'
                })
                if ($runtimeResidue.Count -gt 0 -or $launcherResidue.Count -gt 0) {
                    throw "rigyn install: standalone transaction residue exists without its recovery record"
                }
                return
            }
            try {
                $record = [IO.File]::ReadAllText($recordPath) | ConvertFrom-Json
            } catch {
                throw "rigyn install: standalone runtime transaction is invalid: $recordPath"
            }
            $names = @($record.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
            $expectedNames = @("backup", "distribution", "hadPrevious", "launcherBackup", "launcherHadPrevious", "launcherStage", "phase", "product", "runtime", "schemaVersion", "stage")
            $stageMatch = [Regex]::Match([string]$record.stage, '\A\.rigyn-stage-(?<id>[a-f0-9]{32})\z')
            $transactionId = if ($stageMatch.Success) { $stageMatch.Groups["id"].Value } else { "" }
            $expectedBackup = ".rigyn-backup-$transactionId"
            $expectedLauncherStage = ".rigyn-$transactionId.cmd"
            try {
                $valid = (
                    ($names -join "`n") -ceq ($expectedNames -join "`n") -and
                    [string]$record.product -ceq "rigyn" -and
                    $record.schemaVersion -eq 1 -and
                    [string]$record.distribution -ceq "standalone" -and
                    [string]$record.phase -cmatch '\A(prepared|previous-isolated|replacement-installed|launcher-installed|committed)\z' -and
                    [string]$record.runtime -cmatch ('\Arigyn-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-win32-' + [Regex]::Escape($Architecture) + '\z') -and
                    $stageMatch.Success -and
                    $record.hadPrevious -is [bool] -and
                    $record.launcherHadPrevious -is [bool] -and
                    [string]$record.launcherStage -ceq $expectedLauncherStage -and
                    [string]$record.launcherBackup -ceq ($expectedLauncherStage + ".previous") -and
                    (($record.hadPrevious -and [string]$record.backup -ceq $expectedBackup) -or
                        (-not $record.hadPrevious -and $null -eq $record.backup))
                )
            } catch {
                $valid = $false
            }
            if (-not $valid) {
                throw "rigyn install: standalone runtime transaction is invalid: $recordPath"
            }
            $target = Join-Path $RuntimeRoot ([string]$record.runtime)
            $stageParent = Join-Path $RuntimeRoot ([string]$record.stage)
            $backupParent = if ($record.hadPrevious) { Join-Path $RuntimeRoot ([string]$record.backup) } else { $null }
            $backupTarget = if ($null -ne $backupParent) { Join-Path $backupParent ([string]$record.runtime) } else { $null }
            $stagedLauncher = Join-Path $LauncherDirectory ([string]$record.launcherStage)
            $launcherBackup = Join-Path $LauncherDirectory ([string]$record.launcherBackup)
            $targetExists = Test-rigynRecoveryDirectory $target "standalone runtime transaction target"
            $stageExists = Test-rigynRecoveryDirectory $stageParent "standalone runtime transaction stage"
            $backupExists = $null -ne $backupTarget -and (Test-rigynRecoveryDirectory $backupTarget "standalone runtime transaction backup")
            if ($null -ne $backupParent -and (Test-Path -LiteralPath $backupParent)) {
                [void](Test-rigynRecoveryDirectory $backupParent "standalone runtime transaction backup parent")
                $backupEntries = @(Get-ChildItem -LiteralPath $backupParent -Force)
                if ($backupEntries.Count -gt 1 -or
                    ($backupEntries.Count -eq 1 -and $backupEntries[0].Name -cne [string]$record.runtime)) {
                    throw "rigyn install: standalone runtime transaction backup contains unexpected residue"
                }
            }
            $launcherExists = Test-rigynRecoveryFile $Launcher "standalone launcher" 4096
            $launcherBackupExists = Test-rigynRecoveryFile $launcherBackup "standalone launcher backup" 4096
            [void](Test-rigynRecoveryFile $stagedLauncher "standalone launcher stage" 4096)
            $expectedLauncher = "@echo off`r`nrem rigyn standalone managed command`r`n`"%USERPROFILE%\.rigyn\runtime\$([string]$record.runtime)\bin\rigyn.cmd`" %*`r`n"

            if ([string]$record.phase -ceq "committed") {
                if (-not $targetExists -or -not $launcherExists -or
                    [IO.File]::ReadAllText($Launcher) -cne $expectedLauncher) {
                    throw "rigyn install: committed standalone transaction lost its runtime or launcher"
                }
            } else {
                if ($record.hadPrevious) {
                    if ($backupExists) {
                        if ($targetExists) {
                            Remove-rigynSafeRecoveryTree $target
                        }
                        Move-Item -LiteralPath $backupTarget -Destination $target
                        $targetExists = $true
                        $backupExists = $false
                    } elseif (-not $targetExists -or [string]$record.phase -cne "prepared") {
                        throw "rigyn install: standalone runtime transaction lost both its target and backup"
                    }
                } elseif ($targetExists) {
                    Remove-rigynSafeRecoveryTree $target
                    $targetExists = $false
                }

                if ($record.launcherHadPrevious) {
                    if ($launcherBackupExists) {
                        if ($launcherExists) {
                            $currentLauncher = [IO.File]::ReadAllText($Launcher)
                            if ($currentLauncher -notmatch $ManagedLauncherPattern) {
                                throw "rigyn install: standalone launcher changed during transaction recovery"
                            }
                            Remove-Item -LiteralPath $Launcher -Force
                        }
                        Move-Item -LiteralPath $launcherBackup -Destination $Launcher
                        $launcherExists = $true
                    } elseif (-not $launcherExists -or [string]$record.phase -cne "prepared") {
                        throw "rigyn install: standalone transaction lost its previous launcher backup"
                    } elseif ([IO.File]::ReadAllText($Launcher) -notmatch $ManagedLauncherPattern) {
                        throw "rigyn install: standalone launcher changed during transaction recovery"
                    }
                } elseif ($launcherExists) {
                    if ([IO.File]::ReadAllText($Launcher) -cne $expectedLauncher) {
                        throw "rigyn install: standalone launcher changed during transaction recovery"
                    }
                    Remove-Item -LiteralPath $Launcher -Force
                    $launcherExists = $false
                }
            }

            if ($stageExists) {
                Remove-rigynRecoveryTree $stageParent $RuntimeRoot ".rigyn-stage-"
            }
            if ($null -ne $backupParent -and (Test-Path -LiteralPath $backupParent)) {
                Remove-rigynRecoveryTree $backupParent $RuntimeRoot ".rigyn-backup-"
            }
            foreach ($temporaryLauncher in @($stagedLauncher, $launcherBackup)) {
                if (Test-Path -LiteralPath $temporaryLauncher) {
                    [void](Test-rigynRecoveryFile $temporaryLauncher "standalone launcher transaction residue" 4096)
                    Remove-Item -LiteralPath $temporaryLauncher -Force
                }
            }
            Remove-Item -LiteralPath $recordPath -Force
        }

        $assetRoot = "$releaseRoot/download/$tag"
        $checksumPath = Join-Path $temporaryRoot "SHA256SUMS"
        $archiveName = "rigyn-v$version-win32-$arch.tar.gz"
        $archivePath = Join-Path $temporaryRoot $archiveName
        Get-rigynAsset "$assetRoot/SHA256SUMS" $checksumPath 1048576
        Get-rigynAsset "$assetRoot/$archiveName" $archivePath 1073741824

        $checksumPattern = '^([a-f0-9]{64})  ' + [Regex]::Escape($archiveName) + '$'
        $checksumMatches = @(
            foreach ($line in Get-Content -LiteralPath $checksumPath) {
                $match = [Regex]::Match($line, $checksumPattern)
                if ($match.Success) { $match.Groups[1].Value }
            }
        )
        if ($checksumMatches.Count -ne 1) {
            throw "rigyn install: SHA256SUMS must list $archiveName exactly once"
        }
        $actual = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $checksumMatches[0]) {
            throw "rigyn install: checksum mismatch for $archiveName"
        }

        $archiveRoot = $archiveName.Substring(0, $archiveName.Length - ".tar.gz".Length)
        $entries = @(& $tarCommand.Source -tzf $archivePath)
        if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) {
            throw "rigyn install: $archiveName is not a readable tar.gz archive"
        }
        $entryMetadata = @(& $tarCommand.Source -tvzf $archivePath)
        if ($LASTEXITCODE -ne 0 -or $entryMetadata.Count -eq 0) {
            throw "rigyn install: $archiveName metadata could not be inspected"
        }
        foreach ($metadata in $entryMetadata) {
            if ($metadata -notmatch '^[-d]') {
                throw "rigyn install: $archiveName contains an unsupported entry type"
            }
        }
        foreach ($entry in $entries) {
            if ([string]::IsNullOrEmpty($entry) -or $entry.Contains("\") -or
                ($entry -ne $archiveRoot -and -not $entry.StartsWith("$archiveRoot/")) -or
                $entry.Contains("/../") -or $entry.EndsWith("/..") -or
                $entry.Contains("/./") -or $entry.EndsWith("/.") -or $entry.Contains("//")) {
                throw "rigyn install: $archiveName contains an unsafe path"
            }
        }

        $extractRoot = Join-Path $temporaryRoot "extract"
        [void](New-Item -ItemType Directory -Path $extractRoot)
        & $tarCommand.Source -xzf $archivePath -C $extractRoot
        if ($LASTEXITCODE -ne 0) {
            throw "rigyn install: could not extract $archiveName"
        }
        $payload = Join-Path $extractRoot $archiveRoot
        $required = @(
            "bin\rigyn.cmd",
            "BUILD-METADATA.json",
            "lib\node_modules\rigyn\resources\AGENTS.md",
            "lib\node_modules\rigyn\resources\config.example.json"
        )
        foreach ($relative in $required) {
            $path = Join-Path $payload $relative
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
                ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "rigyn install: $archiveName is missing $relative"
            }
        }

        $rigynRoot = Join-Path $HOME ".rigyn"
        $lifecycleLease = Enter-rigynLifecycle $rigynRoot
        Repair-rigynInterruptedStandaloneUninstall $rigynRoot
        [void](New-Item -ItemType Directory -Force -Path $rigynRoot)
        $rigynRootItem = Get-Item -LiteralPath $rigynRoot -Force
        if (-not $rigynRootItem.PSIsContainer -or
            ($rigynRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "rigyn install: standalone installation root is not a safe directory: $rigynRoot"
        }
        foreach ($sourceOwnedName in @(
            ".installation.json",
            ".install-transaction.json",
            ".app-install",
            ".build-install",
            ".app-previous",
            "app"
        )) {
            if ($null -ne (Get-Item -LiteralPath (Join-Path $rigynRoot $sourceOwnedName) -Force -ErrorAction SilentlyContinue)) {
                throw "rigyn install: a source-built installation owns $rigynRoot; preserve $rigynRoot and follow the state-preserving distribution-switch steps before installing the standalone runtime"
            }
        }
        $runtimeLeases = Join-Path $rigynRoot ".runtime-leases"
        $runtimeLeaseItem = Get-Item -LiteralPath $runtimeLeases -Force -ErrorAction SilentlyContinue
        if ($null -ne $runtimeLeaseItem) {
            if (-not $runtimeLeaseItem.PSIsContainer -or
                ($runtimeLeaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "rigyn install: standalone runtime lease path is unsafe: $runtimeLeases"
            }
            foreach ($runtimeLeaseItem in @(Get-ChildItem -LiteralPath $runtimeLeases -Force)) {
                $runtimeLease = Get-rigynRuntimeLease $runtimeLeaseItem
                if ($null -eq $runtimeLease) {
                    throw "rigyn install: standalone runtime lease entry is invalid: $($runtimeLeaseItem.Name)"
                }
                if ($null -ne (Get-Process -Id $runtimeLease.Pid -ErrorAction SilentlyContinue)) {
                    throw "rigyn install: close every running rigyn process before updating the standalone installation"
                }
                $currentLeaseItem = Get-Item -LiteralPath $runtimeLeaseItem.FullName -Force -ErrorAction SilentlyContinue
                if ($null -eq $currentLeaseItem) {
                    continue
                }
                $currentLease = Get-rigynRuntimeLease $currentLeaseItem
                if ($null -eq $currentLease -or $currentLease.Contents -cne $runtimeLease.Contents) {
                    throw "rigyn install: standalone runtime lease changed while the installation was being updated"
                }
                Remove-Item -LiteralPath $runtimeLeaseItem.FullName -Force
            }
        }
        $launcherRuntimeRoot = "%USERPROFILE%\.rigyn\runtime"
        $runtimeRoot = Join-Path $rigynRoot "runtime"
        $target = Join-Path $runtimeRoot $archiveRoot
        [void](New-Item -ItemType Directory -Force -Path $runtimeRoot)
        $runtimeRootItem = Get-Item -LiteralPath $runtimeRoot -Force
        if (-not $runtimeRootItem.PSIsContainer -or
            ($runtimeRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "rigyn install: standalone runtime root is not a safe directory: $runtimeRoot"
        }

        $launcherDirectory = Join-Path $rigynRoot "bin"
        $launcher = Join-Path $launcherDirectory "rigyn.cmd"
        [void](New-Item -ItemType Directory -Force -Path $launcherDirectory)
        $launcherDirectoryItem = Get-Item -LiteralPath $launcherDirectory -Force
        if (-not $launcherDirectoryItem.PSIsContainer -or
            ($launcherDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "rigyn install: launcher directory is not a safe directory: $launcherDirectory"
        }
        $managedLauncherPattern = '\A@echo off\r?\nrem rigyn standalone managed command\r?\n"%USERPROFILE%\\\.rigyn\\runtime\\(?<runtime>rigyn-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?-win32-(?:x64|arm64))\\bin\\rigyn\.cmd" %\*\r?\n?\z'
        Repair-rigynInterruptedInstall $runtimeRoot $launcherDirectory $launcher $managedLauncherPattern $arch
        $launcherItem = Get-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
        $launcherHadPrevious = $false
        if ($null -ne $launcherItem) {
            if ($launcherItem.PSIsContainer -or
                ($launcherItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "rigyn install: refusing to replace an unmanaged command: $launcher"
            }
            $existingLauncher = Get-Content -LiteralPath $launcher -Raw
            if ($existingLauncher -match $managedLauncherPattern) {
                $launcherHadPrevious = $true
            } else {
                throw "rigyn install: refusing to replace an unmanaged command: $launcher"
            }
        }
        $launcherTarget = "$launcherRuntimeRoot\$archiveRoot\bin\rigyn.cmd"
        $launcherContents = (
            "@echo off`r`n" +
            "rem rigyn standalone managed command`r`n" +
            "`"$launcherTarget`" %*`r`n"
        )
        $transactionId = [Guid]::NewGuid().ToString("N")
        $stagedLauncher = Join-Path $launcherDirectory (".rigyn-$transactionId.cmd")
        $launcherBackup = "$stagedLauncher.previous"

        $rigynHome = if ([string]::IsNullOrEmpty($env:RIGYN_HOME)) {
            $rigynRoot
        } else {
            $env:RIGYN_HOME
        }
        [void](New-Item -ItemType Directory -Force -Path $rigynHome)
        $rigynHomeItem = Get-Item -LiteralPath $rigynHome -Force
        if (-not $rigynHomeItem.PSIsContainer -or
            ($rigynHomeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "rigyn install: rigyn home is not a safe directory: $rigynHome"
        }
        $scaffolds = @(
            @{ Destination = "AGENTS.md"; Source = "AGENTS.md"; Label = "Agent instructions" },
            @{ Destination = "config.json"; Source = "config.example.json"; Label = "Rigyn configuration" }
        )
        foreach ($scaffold in $scaffolds) {
            $destination = Join-Path $rigynHome $scaffold.Destination
            [void](Test-rigynScaffoldDestination $destination $scaffold.Label)
        }

        $stageParent = Join-Path $runtimeRoot ".rigyn-stage-$transactionId"
        $stagedTarget = Join-Path $stageParent $archiveRoot
        $runtimeHadPrevious = Test-Path -LiteralPath $target
        if ($runtimeHadPrevious) {
            $targetItem = Get-Item -LiteralPath $target -Force
            if (-not $targetItem.PSIsContainer -or
                ($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "rigyn install: existing standalone runtime is not a safe rigyn installation: $target"
            }
        }
        $backupParent = if ($runtimeHadPrevious) { Join-Path $runtimeRoot ".rigyn-backup-$transactionId" } else { $null }
        $backup = if ($runtimeHadPrevious) { Join-Path $backupParent $archiveRoot } else { $null }
        $transactionPath = Join-Path $runtimeRoot ".rigyn-install-transaction.json"
        $transactionRecord = [ordered]@{
            product = "rigyn"
            schemaVersion = 1
            distribution = "standalone"
            phase = "prepared"
            runtime = $archiveRoot
            stage = [IO.Path]::GetFileName($stageParent)
            backup = if ($runtimeHadPrevious) { [IO.Path]::GetFileName($backupParent) } else { $null }
            hadPrevious = $runtimeHadPrevious
            launcherStage = [IO.Path]::GetFileName($stagedLauncher)
            launcherBackup = [IO.Path]::GetFileName($launcherBackup)
            launcherHadPrevious = $launcherHadPrevious
        }
        $runtimeCommitStarted = $false
        $launcherCommitStarted = $false
        $launcherRestoreFailed = $false
        $transactionCommitted = $false
        $createdScaffolds = @()
        try {
            Write-rigynInstallTransaction $transactionPath $transactionRecord "prepared"
            [void](New-Item -ItemType Directory -Path $stageParent)
            [IO.File]::WriteAllText($stagedLauncher, $launcherContents, [Text.Encoding]::ASCII)
            if ($launcherHadPrevious) {
                Copy-Item -LiteralPath $launcher -Destination $launcherBackup
            }
            Move-Item -LiteralPath $payload -Destination $stagedTarget
            if ($runtimeHadPrevious) {
                [void](New-Item -ItemType Directory -Path $backupParent)
            }
            $runtimeCommitStarted = $true
            if ($runtimeHadPrevious) {
                Move-Item -LiteralPath $target -Destination $backup
                Write-rigynInstallTransaction $transactionPath $transactionRecord "previous-isolated"
            }

            Move-Item -LiteralPath $stagedTarget -Destination $target
            Write-rigynInstallTransaction $transactionPath $transactionRecord "replacement-installed"

            $resources = Join-Path $target "lib\node_modules\rigyn\resources"
            foreach ($scaffold in $scaffolds) {
                $destination = Join-Path $rigynHome $scaffold.Destination
                if (-not (Test-rigynScaffoldDestination $destination $scaffold.Label)) {
                    $createdScaffolds += $destination
                    Copy-Item -LiteralPath (Join-Path $resources $scaffold.Source) -Destination $destination
                }
            }

            $launcherCommitStarted = $true
            Move-Item -LiteralPath $stagedLauncher -Destination $launcher -Force
            Write-rigynInstallTransaction $transactionPath $transactionRecord "launcher-installed"
            $installedVersionOutput = @(& $launcher --version)
            if ($LASTEXITCODE -ne 0) {
                throw "rigyn install: the installed rigyn command failed its version check"
            }
            $installedVersion = ($installedVersionOutput -join "`n").Trim()
            if ($installedVersion -cne $version) {
                throw "rigyn install: the installed rigyn command reported an unexpected version"
            }
            Write-rigynInstallTransaction $transactionPath $transactionRecord "committed"
            $transactionCommitted = $true
        } finally {
            $rollbackErrors = @()
            if (-not $transactionCommitted) {
                if ($launcherCommitStarted) {
                    try {
                        if ($launcherHadPrevious -and (Test-Path -LiteralPath $launcherBackup)) {
                            if ($null -ne (Get-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue)) {
                                Remove-Item -LiteralPath $launcher -Force
                            }
                            Move-Item -LiteralPath $launcherBackup -Destination $launcher
                        } elseif ($null -ne (Get-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue)) {
                            $currentLauncher = Get-Content -LiteralPath $launcher -Raw
                            if ($currentLauncher -eq $launcherContents) {
                                Remove-Item -LiteralPath $launcher -Force
                            }
                        }
                    } catch {
                        $launcherRestoreFailed = $true
                        $rollbackErrors += "launcher: $($_.Exception.Message)"
                    }
                }
                foreach ($createdScaffold in $createdScaffolds) {
                    try {
                        if ($null -ne (Get-Item -LiteralPath $createdScaffold -Force -ErrorAction SilentlyContinue)) {
                            Remove-Item -LiteralPath $createdScaffold -Force
                        }
                    } catch {
                        $rollbackErrors += "scaffold: $($_.Exception.Message)"
                    }
                }
                if ($runtimeCommitStarted) {
                    try {
                        $installedTarget = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
                        if ($null -ne $installedTarget) {
                            if (-not $installedTarget.PSIsContainer -or
                                ($installedTarget.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                                throw "replacement target is no longer a safe directory"
                            }
                            Remove-Item -LiteralPath $target -Recurse -Force
                        }
                    } catch {
                        $rollbackErrors += "runtime: $($_.Exception.Message)"
                    }
                    try {
                        if ($null -ne $backup -and
                            (Test-Path -LiteralPath $backup) -and
                            -not (Test-Path -LiteralPath $target)) {
                            Move-Item -LiteralPath $backup -Destination $target
                        }
                    } catch {
                        $rollbackErrors += "runtime backup: $($_.Exception.Message)"
                    }
                }
            }
            if (Test-Path -LiteralPath $stageParent) {
                try {
                    Remove-Item -LiteralPath $stageParent -Recurse -Force
                } catch {
                    $rollbackErrors += "runtime stage: $($_.Exception.Message)"
                }
            }
            if ($null -ne $backupParent -and (Test-Path -LiteralPath $backupParent)) {
                if ($transactionCommitted -or
                    $null -eq $backup -or
                    -not (Test-Path -LiteralPath $backup)) {
                    try {
                        Remove-Item -LiteralPath $backupParent -Recurse -Force
                    } catch {
                        $rollbackErrors += "runtime backup cleanup: $($_.Exception.Message)"
                    }
                }
            }
            foreach ($launcherTemporary in @($stagedLauncher)) {
                if (Test-Path -LiteralPath $launcherTemporary) {
                    try {
                        Remove-Item -LiteralPath $launcherTemporary -Force
                    } catch {
                        $rollbackErrors += "launcher stage: $($_.Exception.Message)"
                    }
                }
            }
            if (-not $launcherRestoreFailed -and (Test-Path -LiteralPath $launcherBackup)) {
                try {
                    Remove-Item -LiteralPath $launcherBackup -Force
                } catch {
                    $rollbackErrors += "launcher backup cleanup: $($_.Exception.Message)"
                }
            }
            if ($rollbackErrors.Count -eq 0 -and (Test-Path -LiteralPath $transactionPath)) {
                try {
                    Remove-Item -LiteralPath $transactionPath -Force
                } catch {
                    $rollbackErrors += "transaction record cleanup: $($_.Exception.Message)"
                }
            }
            if ($rollbackErrors.Count -gt 0) {
                $preservedBackups = @()
                if ($null -ne $backup -and (Test-Path -LiteralPath $backup)) {
                    $preservedBackups += $backup
                }
                if (Test-Path -LiteralPath $launcherBackup) {
                    $preservedBackups += $launcherBackup
                }
                $backupNotice = if ($preservedBackups.Count -gt 0) {
                    "; backup preserved at $($preservedBackups -join ', ')"
                } else { "" }
                $failureKind = if ($transactionCommitted) { "cleanup" } else { "rollback" }
                throw "rigyn install: standalone installation $failureKind failed${backupNotice}: $($rollbackErrors -join '; ')"
            }
        }

        Write-Output "rigyn $version was installed from its verified GitHub standalone release."
        Write-Output "rigyn home: $rigynRoot"
        Write-Output "Runtime: $target"
        Write-Output "Command: $launcher"
        if (($env:PATH -split ';') -notcontains $launcherDirectory) {
            Write-Output "Add $launcherDirectory to PATH, then run rigyn."
        }
    } finally {
        Exit-rigynLifecycle $lifecycleLease
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
        if ($null -ne $temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }
}
