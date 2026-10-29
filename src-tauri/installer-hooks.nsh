; SPDX-License-Identifier: Apache-2.0
; Copyright (c) 2026 Raku Inkyetta 羽梦千景
;
; NSIS 安装器钩子：只清理 FontFox 自己的数据。
; 不触碰 Inactive Fonts（用户的功能状态），也不清理任何字体注册项。

!macro NSIS_HOOK_POSTUNINSTALL
  ; 配置目录：%USERPROFILE%\.FontFox（配置、字体单、待清理清单、动态模式隔离目录）
  RMDir /r "$PROFILE\.FontFox"
!macroend