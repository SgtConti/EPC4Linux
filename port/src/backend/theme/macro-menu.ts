// Macro_GetFuncMenu (SO:2544-2552): GlobalOper.MakeMacroCmdMenuData(smethod_17()) (GO:232-279).
//
// The 20-enum catalog lacks this fixture (its appendix D.5); the menu is therefore derived here from
// the vendor code itself, by porting MakeMacroCmdMenuData over transcriptions of its inputs:
//   - smethod_17 (SO:2554-2842): the fixed List<SupportButtonFunc> of 49 {ButtonFunc, ButtonMenu,
//     SubMenu} entries, in list order;
//   - ButtonMenu (EN/ButtonMenu.cs), ButtonSubMenu_AppUser (EN/ButtonSubMenu_AppUser.cs) and
//     ButtonExtFunc (EN/ButtonExtFunc.cs) through Extension_Enum.GetDatas (COM/Extension_Enum.cs:108):
//     [UnbindEnumExtended] members skipped, Text = [Description] or the member name, sorted by Value;
//   - ButtonFunc names/values/descriptions (EN/ButtonFunc.cs:419-515) for the 49 functions;
//   - the entity shapes: ButtonMenuData {Items, ExtFuncDef} (ExtFuncDef initialised with
//     GetDatas(ButtonExtFunc)), ButtonMenuItem : EnumItem {ChildList} and ExtEnumItem : EnumItem
//     {ExtData = SupportButtonFunc.ExtData = ""}; Newtonsoft writes the derived class's members first.
// The result is checked byte-for-byte against the golden reply of 20-backend-host-tail §5 step 9
// (Tag = 4025 characters) in test/unit/theme/api-macro.test.ts ("Macro_GetFuncMenu" golden test, reply
// stored in test/unit/theme/fixtures/macro-getfuncmenu.reply.json).

/** ButtonMenu members (real names from the obfuscated tree, work/dotnet; `unbind` = [UnbindEnumExtended]). */
const BUTTON_MENU: readonly { name: string; text: string; value: number; unbind?: true }[] = [
  { name: 'NULL', text: 'NULL', value: -1, unbind: true },
  { name: 'Preset', text: '预设', value: 0 },
  { name: 'Disable', text: '禁用', value: 1 },
  { name: 'KeyboardFunc', text: '键盘功能', value: 2 },
  { name: 'MouseFunc', text: '滑鼠功能', value: 3 },
  { name: 'SwitchDPI', text: 'DPI设定', value: 4 },
  { name: 'Macro', text: '巨集', value: 5 },
  { name: 'Text', text: '文字功能', value: 6 },
  { name: 'SwitchProfile', text: '切换Profile', value: 7 },
  { name: 'SwitchLighting', text: '切换灯效', value: 8 },
  { name: 'LaunchProgram', text: '启动程式', value: 9 },
  { name: 'Media', text: '多媒体', value: 10 },
  { name: 'PShiftKey', text: 'P-Shift按键设定', value: 11 },
  { name: 'AppUser', text: 'Windows 捷径', value: 12 },
  { name: 'DeviceFunc', text: '设备功能', value: 13 },
];

const MENU_LAUNCH_PROGRAM = 9;
const MENU_MEDIA = 10;
const MENU_APP_USER = 12;

/** ButtonSubMenu_AppUser (NULL = -1 is unbound). */
const APP_USER_SUB_MENU: readonly { name: string; text: string; value: number }[] = [
  { name: 'Productivity', text: 'Productivity', value: 0 },
  { name: 'Windows', text: 'Windows', value: 1 },
  { name: 'Editing', text: 'Editing', value: 2 },
  { name: 'Navigation', text: 'Navigation', value: 3 },
];

/** ButtonExtFunc. */
const BUTTON_EXT_FUNC: readonly { name: string; text: string; value: number }[] = [
  { name: 'ApplyToThemeCycleProfiles', text: '将功能应用到当前主题下所有循环Profile中', value: 0 },
  { name: 'ApplyToThemeCycleOnBoards', text: '将功能应用到所有板载中', value: 1 },
];

/** smethod_17: [ButtonFunc name, value, [Description], ButtonMenu value, SubMenu] in list order. */
const SUPPORT_BUTTON_FUNCS: readonly (readonly [string, number, string, number, number])[] = [
  ['LaunchExe', 864, '启动exe程序', MENU_LAUNCH_PROGRAM, -1],
  ['LaunchWebsite', 865, '启动网页', MENU_LAUNCH_PROGRAM, -1],
  ['Media_Mute', 880, '静音', MENU_MEDIA, -1],
  ['Media_VolumeDown', 881, '音量减少', MENU_MEDIA, -1],
  ['Media_VolumeUp', 882, '音量增大', MENU_MEDIA, -1],
  ['Media_PreviousTrack', 883, '上一曲', MENU_MEDIA, -1],
  ['Media_NextTrack', 884, '下一曲', MENU_MEDIA, -1],
  ['Media_PlayOrPause', 885, '播放/暂停', MENU_MEDIA, -1],
  ['Media_Stop', 886, '停止', MENU_MEDIA, -1],
  ['User_LaunchCalc', 928, 'LaunchCalc', MENU_APP_USER, 0],
  ['User_LaunchMspaint', 929, 'LaunchMspaint', MENU_APP_USER, 0],
  ['User_LaunchNotepad', 930, 'LaunchNotepad', MENU_APP_USER, 0],
  ['User_LaunchSnippingtool', 931, 'LaunchSnippingtool', MENU_APP_USER, 0],
  ['User_ShowDesktop', 944, 'ShowDesktop', MENU_APP_USER, 1],
  ['User_LockScreen', 945, 'LockScreen', MENU_APP_USER, 1],
  ['User_OpenGameBar', 946, 'OpenGameBar', MENU_APP_USER, 1],
  ['User_OpenSearch', 947, 'OpenSearch', MENU_APP_USER, 1],
  ['User_OpenNarrator', 948, 'OpenNarrator', MENU_APP_USER, 1],
  ['User_OpenActionCenter', 949, 'OpenActionCenter', MENU_APP_USER, 1],
  ['User_FocusNotifyArea', 950, 'FocusNotifyArea', MENU_APP_USER, 1],
  ['User_OpenExplorer', 951, 'OpenExplorer', MENU_APP_USER, 1],
  ['User_OpenSetting', 952, 'OpenSetting', MENU_APP_USER, 1],
  ['User_OpenConnect', 953, 'OpenConnect', MENU_APP_USER, 1],
  ['User_MiniAllWins', 954, 'MiniAllWins', MENU_APP_USER, 1],
  ['User_RunDialog', 955, 'RunDialog', MENU_APP_USER, 1],
  ['User_CycleTaskBarApps', 956, 'CycleTaskApps', MENU_APP_USER, 1],
  ['User_OpenEaseOfAccess', 957, 'OpenEaseOfAccess', MENU_APP_USER, 1],
  ['User_OpenTaskView', 958, 'OpenTaskView', MENU_APP_USER, 1],
  ['User_OpenMagnifier', 959, 'OpenMagnifier', MENU_APP_USER, 1],
  ['User_OpenEmojiPanel', 960, 'OpenEmojiPanel', MENU_APP_USER, 1],
  ['User_Copy', 976, 'Copy', MENU_APP_USER, 2],
  ['User_Paste', 977, 'Paste', MENU_APP_USER, 2],
  ['User_Cut', 978, 'Cut', MENU_APP_USER, 2],
  ['User_Redo', 979, 'Redo', MENU_APP_USER, 2],
  ['User_Undo', 980, 'Undo', MENU_APP_USER, 2],
  ['User_SelectAll', 981, 'SelectAll', MENU_APP_USER, 2],
  ['User_Save', 982, 'Save', MENU_APP_USER, 2],
  ['User_New', 983, 'New', MENU_APP_USER, 2],
  ['User_Open', 984, 'Open', MENU_APP_USER, 2],
  ['User_NewTab', 985, 'NewTab', MENU_APP_USER, 2],
  ['User_CloseTab', 986, 'CloseTab', MENU_APP_USER, 2],
  ['User_GoBack', 992, 'GoBack', MENU_APP_USER, 3],
  ['User_GoForward', 993, 'GoForward', MENU_APP_USER, 3],
  ['User_OpenStart', 994, 'OpenStart', MENU_APP_USER, 3],
  ['User_OpenTaskManager', 995, 'OpenTaskManager', MENU_APP_USER, 3],
  ['User_ExitActiveApp', 996, 'ExitActiveApp', MENU_APP_USER, 3],
  ['User_SwitchBetweenApps', 997, 'SwitchBetweenApps', MENU_APP_USER, 3],
  ['User_CycleThroughApps', 998, 'CycleThroughApps', MENU_APP_USER, 3],
];

interface EnumItemJson {
  Name: string;
  Text: string;
  Value: number;
}

interface ExtEnumItemJson {
  ExtData: string;
  Name: string;
  Text: string;
  Value: number;
}

interface ButtonMenuItemJson {
  ChildList: (ExtEnumItemJson | ButtonMenuItemJson)[];
  Name: string;
  Text: string;
  Value: number;
}

export interface ButtonMenuDataJson {
  Items: ButtonMenuItemJson[];
  ExtFuncDef: EnumItemJson[];
}

type Func = (typeof SUPPORT_BUTTON_FUNCS)[number];

/** new ExtEnumItem(item.ButtonFunc.GetItem(), item.ExtData) — ExtData first (derived member). */
function extItem(f: Func): ExtEnumItemJson {
  return { ExtData: '', Name: f[0], Text: f[2], Value: f[1] };
}

function menuItem(item: { name: string; text: string; value: number }, children: Func[]): ButtonMenuItemJson {
  return { ChildList: children.map(extItem), Name: item.name, Text: item.text, Value: item.value };
}

/** GlobalOper.MakeMacroCmdMenuData (GO:232-279) over smethod_17's list. */
export function makeMacroCmdMenuData(): ButtonMenuDataJson {
  const data: ButtonMenuDataJson = {
    Items: [],
    ExtFuncDef: BUTTON_EXT_FUNC.map((e) => ({ Name: e.name, Text: e.text, Value: e.value })),
  };
  for (const menu of BUTTON_MENU.filter((m) => !m.unbind).sort((a, b) => a.value - b.value)) {
    const list = SUPPORT_BUTTON_FUNCS.filter((f) => f[3] === menu.value);
    if (list.length === 0) continue;
    switch (menu.value) {
      case MENU_LAUNCH_PROGRAM:
        // One item per function, holding that function as its only child.
        for (const f of list) data.Items.push(menuItem({ name: f[0], text: f[2], value: f[1] }, [f]));
        break;
      case MENU_MEDIA:
        data.Items.push(menuItem(menu, list));
        break;
      case MENU_APP_USER:
        for (const sub of APP_USER_SUB_MENU) {
          const children = list.filter((f) => f[4] === sub.value);
          if (children.length > 0) data.Items.push(menuItem(sub, children));
        }
        break;
      default:
        break;
    }
  }
  return data;
}
