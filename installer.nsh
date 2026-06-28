!macro customInstall
  ; 检查 VC++ 运行时是否已安装 (x64)
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == ""
    DetailPrint "正在安装 Visual C++ Redistributable (x64)..."
    SetOutPath "$TEMP"
    File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ExecWait '"$TEMP\vc_redist.x64.exe" /quiet /norestart' $0
    Delete "$TEMP\vc_redist.x64.exe"
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "Visual C++ Redistributable 安装可能失败。如果应用无法运行，请手动安装。"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; 卸载时无需删除 VC++，因为它是共享组件
!macroend
