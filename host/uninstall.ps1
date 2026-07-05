# Removes the AI Bridge native-messaging host registration (current user).
$ErrorActionPreference = "SilentlyContinue"
$reg = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.aibridge.host"
Remove-Item -Path $reg -Force
Write-Host "Removed registry key: $reg"
