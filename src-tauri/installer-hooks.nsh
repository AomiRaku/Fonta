; SPDX-License-Identifier: Apache-2.0
; Copyright (c) 2026 Fontade Contributors
;
; NSIS 安装器钩子：只清理 Fontade 自己的数据。
; 不触碰 Inactive Fonts（用户的功能状态），也不清理任何字体注册项。

!macro NSIS_HOOK_POSTUNINSTALL
  ; 配置目录：%USERPROFILE%\.Fontade（配置 + 待清理清单）
  RMDir /r "$PROFILE\.Fontade"
!macroend
