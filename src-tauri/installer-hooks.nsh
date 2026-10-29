; SPDX-License-Identifier: Apache-2.0
; Copyright (c) 2026 Raku Inkyetta 羽梦千景
;
; NSIS 安装器钩子。
;
; 卸载前：
;   - 动态安装卸载模式：必须恢复所有隔离字体（静默执行，不询问）；
;   - Windows 默认模式：询问用户是否恢复被隐藏的字体。
; 恢复动作由应用自身完成（`fontfox.exe --restore-fonts`，不创建窗口）。
; 卸载后：只清理 FontFox 自己的数据目录，不触碰字体注册项。

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $0 ""
  ReadINIStr $0 "$PROFILE\.FontFox\config.ini" "general" "DisableMode"
  StrCmp $0 "dynamic" FontFoxRestore FontFoxAsk

FontFoxAsk:
  MessageBox MB_YESNO|MB_ICONQUESTION "是否恢复所有已停用的字体？$\r$\nRestore all disabled fonts?" IDYES FontFoxRestore IDNO FontFoxRestoreDone

FontFoxRestore:
  IfFileExists "$INSTDIR\fontfox.exe" FontFoxRestoreRun FontFoxRestoreDone

FontFoxRestoreRun:
  ExecWait '"$INSTDIR\fontfox.exe" --restore-fonts'

FontFoxRestoreDone:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 配置目录：%USERPROFILE%\.FontFox（配置、字体单、待清理清单、动态模式隔离目录）
  RMDir /r "$PROFILE\.FontFox"
!macroend