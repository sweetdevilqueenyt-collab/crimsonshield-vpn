; Clean up the VPN tunnel and startup task when uninstalling
!macro customUnInstall
  nsExec::Exec '"$PROGRAMFILES64\WireGuard\wireguard.exe" /uninstalltunnelservice CrimsonShield'
  nsExec::Exec 'schtasks /delete /tn "CrimsonShield VPN" /f'
!macroend
