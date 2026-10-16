// Review 15: the web-address endings written in a script other than Latin -- every "xn--" entry of
// IANA's root zone list (https://data.iana.org/TLD/tlds-alpha-by-domain.txt, version 2026101400),
// decoded, in NFC. Used by the web-address check for names (validation.ts): with letters that carry
// vowel signs, the letters.letters check doesn't see "बैंक.कॉम" or "بنكِ.مصر". Regenerate from that
// list when it changes (new endings are rare).
export const NON_LATIN_ENDINGS: readonly string[] = [
  "ελ", "ευ", "бг", "бел", "дети", "ею", "католик", "ком", "мкд", "мон", "москва", "онлайн",
  "орг", "рус", "рф", "сайт", "срб", "укр", "қаз", "հայ", "ישראל", "קום", "ابوظبي", "ارامكو",
  "الاردن", "البحرين", "الجزائر", "السعودية", "العليان", "المغرب", "امارات", "ایران", "بارت",
  "بازار", "بيتك", "بھارت", "تونس", "سودان", "سورية", "شبكة", "عراق", "عرب", "عمان", "فلسطين",
  "قطر", "كاثوليك", "كوم", "مصر", "مليسيا", "موريتانيا", "موقع", "همراه", "پاکستان", "ڀارت",
  "कॉम", "नेट", "भारत", "भारतम्", "भारोत", "संगठन", "বাংলা", "ভারত", "ভাৰত", "ਭਾਰਤ", "ભારત",
  "ଭାରତ", "இந்தியா", "இலங்கை", "சிங்கப்பூர்", "భారత్", "ಭಾರತ", "ഭാരതം", "ලංකා", "คอม", "ไทย",
  "ລາວ", "გე", "みんな", "アマゾン", "クラウド", "グーグル", "コム", "ストア", "セール", "ファッション", "ポイント", "世界", "中信",
  "中国", "中國", "中文网", "亚马逊", "企业", "佛山", "信息", "健康", "八卦", "公司", "公益", "台湾", "台灣", "商城", "商店",
  "商标", "嘉里", "嘉里大酒店", "在线", "大拿", "天主教", "娱乐", "家電", "广东", "微博", "慈善", "我爱你", "手机", "招聘", "政务",
  "政府", "新加坡", "新闻", "时尚", "書籍", "机构", "淡马锡", "游戏", "澳門", "点看", "移动", "组织机构", "网址", "网店", "网站",
  "网络", "联通", "谷歌", "购物", "通販", "集团", "電訊盈科", "飞利浦", "食品", "餐厅", "香格里拉", "香港", "닷넷", "닷컴", "삼성",
  "한국",
];

// Those that are also common names or name parts -- India's ("Bharat") in every script, Sri Lanka's
// ("Lanka", "Ilangai") and Israel's ("Yisrael"). Before these, an initial ("राम.भारत", R. Bharat) is
// a name, so only three or more letters before the dot count as a web address.
export const NAME_LIKE_ENDINGS: readonly string[] = [
  "भारत", "भारतम्", "भारोत", "ভারত", "ভাৰত", "ਭਾਰਤ", "ભારત", "ଭାରତ", "భారత్", "ಭಾರತ", "ഭാരതം",
  "بھارت", "ڀارت", "بارت", "ලංකා", "இலங்கை", "ישראל",
];
