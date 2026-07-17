// V2 外部服务配置
// 目前可以留空；APP 的地图编辑、号码管理、送货清单、照片和备份仍可使用。
window.APP_V2_CONFIG = {
  googleRoutesApiKey: "", // 以后把 Google Routes API Key 填在两个引号中间
  googleRoutesEnabled: false,
  routeTravelMode: "DRIVE",
  firebase: null // 如需改用独立 Firebase 配置，可在此填写
};
