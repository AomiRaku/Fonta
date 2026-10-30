; SPDX-License-Identifier: Apache-2.0
; Copyright (c) 2026 Raku Inkyetta 羽梦千景
;
; NSIS 安装器钩子。
;
; 卸载前：
;   - 动态安装卸载模式：必须恢复所有隔离字体（静默执行，不询问）；
;   - Windows 默认模式：询问用户是否恢复被隐藏的字体。
; 恢复动作由应用自身完成（`fontfox.exe --restore-fonts`）；失败时弹出原生「重试」对话框。
; 卸载后：只清理 FontFox 自己的数据目录，不触碰字体注册项。

Var FontFoxRestoreFailed

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $0 ""
  ; 恢复失败时保留 %USERPROFILE%\.FontFox，避免隔离字体被连目录删除
  StrCpy $FontFoxRestoreFailed "0"
  ReadINIStr $0 "$PROFILE\.FontFox\config.ini" "general" "DisableMode"
  StrCmp $0 "dynamic" FontFoxRestore FontFoxAsk

FontFoxAsk:
  MessageBox MB_YESNO|MB_ICONQUESTION "是否恢复所有已停用的字体？$\r$\nRestore all disabled fonts?" IDYES FontFoxRestore IDNO FontFoxRestoreDone

FontFoxRestore:
  IfFileExists "$INSTDIR\fontfox.exe" FontFoxRestoreRun FontFoxRestoreDone

FontFoxRestoreRun:
  ExecWait '"$INSTDIR\fontfox.exe" --restore-fonts' $1
  StrCmp $1 "0" FontFoxRestoreDone
    StrCpy $FontFoxRestoreFailed "1"

FontFoxRestoreDone:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 恢复失败时保留数据目录：桌面已有一份字体副本，但这里再留一份以防复制不完整
  StrCmp $FontFoxRestoreFailed "1" FontFoxKeepData
  ; 配置目录：%USERPROFILE%\.FontFox（配置、字体单、待清理清单、动态模式隔离目录）
  RMDir /r "$PROFILE\.FontFox"
  Goto FontFoxPostUninstallDone
FontFoxKeepData:
  DetailPrint "FontFox: 字体恢复失败，保留 $PROFILE\.FontFox 供手动恢复。"
FontFoxPostUninstallDone:
!macroend