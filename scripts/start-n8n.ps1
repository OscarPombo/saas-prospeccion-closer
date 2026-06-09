# Carga .env y arranca n8n localmente (sin Docker).
# Uso: desde el directorio raíz del proyecto → .\scripts\start-n8n.ps1

$envFile = Join-Path $PSScriptRoot ".." ".env"

Get-Content $envFile | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' } | ForEach-Object {
    $parts = $_ -split '=', 2
    if ($parts.Length -eq 2) {
        $key   = $parts[0].Trim()
        $value = $parts[1].Trim()
        [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

Write-Host "n8n arrancando en http://localhost:5678 (usuario: $env:N8N_BASIC_AUTH_USER)" -ForegroundColor Cyan
n8n start
