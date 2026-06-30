<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
</p>

<div align="center">

# टेस्टिंग-ओएस

[![सीआई](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![पेजेस](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![लाइसेंस: एमआईटी](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![नोड](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**एआई युग में परीक्षण के लिए ऑपरेटिंग सिस्टम**

*एआई-सहायक सॉफ़्टवेयर के लिए प्रोटोकॉल, साक्ष्य भंडार और शिक्षण लूप।*

<!-- version:start -->
**v1.8.0** — वर्तमान संस्करण। इसमें क्या शामिल है, यह जानने के लिए [CHANGELOG.md](CHANGELOG.md) देखें।
<!-- version:end -->

📖 **[हैंडबुक पढ़ें →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## यह क्या है

`testing-os` आपके रिपॉजिटरी से वास्तविक परीक्षण डेटा रिकॉर्ड करता है, सत्यापित करता है और एआई-आधारित वर्कफ़्लो में उससे सीखता है। इसे किसी रिपॉजिटरी पर इंगित करें, और प्रत्येक परीक्षण रन एक ऐसा प्रमाणित रिकॉर्ड बन जाता है जिस पर आप भरोसा कर सकते हैं — यह स्वयं द्वारा रिपोर्ट किया गया परिणाम नहीं होगा।

आपको क्या मिलेगा:

- **प्रमाणित रिकॉर्ड।** प्रत्येक सबमिशन को वास्तविक सीआई रन से जोड़ा जाता है — प्रदाता की अपनी पहचान के माध्यम से, बिना किसी कुंजी के — इससे पहले कि इसे स्वीकार किया जाए। परिणाम एक छेड़छाड़-रोधी, केवल जोड़ने योग्य प्रमाण भंडार होता है, न कि सम्मान प्रणाली पर आधारित हरी टिक।
- **एक नीति अनुबंध जिसे आप नियंत्रित करते हैं।** YAML में यह घोषित करें कि "सत्यापित" का क्या अर्थ है — एक सीमित, गैर-मूल्यांकन पूर्वानुमान डीएसएल (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) — और इसे अपने सभी रिपॉजिटरी पर लागू करें। नीति को शिप करने से पहले `dogfood-verify lint` के साथ जांचें।
- **एक समानांतर-एजेंट स्वार्म प्रोटोकॉल।** किसी कोडबेस के विरुद्ध बहु-एजेंट ऑडिट चलाएं, फिर कच्चे निष्कर्षों को पुन: प्रयोज्य पैटर्न और सिद्धांतों में बदलें।
- **एक लाइव स्थिति सतह।** प्रति-रिपॉजिटरी रिकॉर्ड, इंडेक्स और एक स्थिति बैज, ये सभी एक ही प्रमाण भंडार से प्रदान किए जाते हैं।

यह [डॉगफूड लैब](https://github.com/dogfood-lab) संगठन का प्रमुख मोनोरेपो है — एक `swarm` सीएलआई के पीछे सात `@dogfood-lab/*` पैकेज।

## त्वरित शुरुआत

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

क्या आप चाहते हैं कि आपके स्वयं के रिपॉजिटरी का परीक्षण डेटा यहां दर्ज किया जाए? **[`examples/` स्टार्टर किट](examples/)** आपको पांच मिनट में इसे शुरू करने में मदद करता है (`npx @dogfood-lab/report` सबमिशन बनाता है; `dogfood-init` वर्कफ़्लो को सेट करता है)। ऑपरेटर गाइड, CLI संदर्भ, स्कीमा संदर्भ और एकीकरण के निर्देश **[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** में उपलब्ध हैं। संस्करण-वार विवरण [CHANGELOG.md](CHANGELOG.md) में दिया गया है।

## खतरा मॉडल

टेस्टिंग-ओएस `mcp-tool-shop-org/*` और `dogfood-lab/*` के तहत विश्वसनीय गिटहब रिपॉजिटरी से `repository_dispatch` के माध्यम से भेजे गए डॉगफूड सबमिशन को संसाधित करता है। सत्यापनकर्ता को गिटहब एक्शन प्रोवेनैंस की आवश्यकता होती है — दावा किए गए रन आईडी को गिटहब एपीआई के माध्यम से पुष्टि की जाती है, और गलत आकार, लापता संदर्भ या अमान्य नीति दावों वाले सबमिशन को अस्वीकार कर दिया जाता है।

**उत्पत्ति प्रमाण का आधार है।** `github` सबमिशन के लिए, सत्यापनकर्ता पुष्टि करता है कि दावा किया गया GitHub Actions रन वास्तव में मौजूद है (GitHub API) और यह सबमिशन के `repo` और `commit_sha` को उस सत्यापित रन से जोड़ता है — एक लाइव, बिना कुंजी वाला जांच जो GitHub की अपनी OIDC पहचान पर आधारित है, इसलिए कोई रिकॉर्ड किसी ऐसे रन या कमिट की पुष्टि नहीं कर सकता जो वास्तव में हुआ ही नहीं। **GitLab CI** का समर्थन वैकल्पिक रूप से किया जाता है (`source.provider: gitlab`); GitLab सबमिशन एकमात्र ऐसा मामला है जहां सत्यापनकर्ता एक गैर-GitHub होस्ट (`gitlab.com/api`) को कॉल करता है, और केवल `gitlab` सबमिशन के लिए।

**रिकॉर्ड की अखंडता छेड़छाड़-विरोधी है, छेड़छाड़-प्रूफ नहीं।** प्रत्येक संग्रहीत रिकॉर्ड में एक `integrity` ब्लॉक होता है (`submission_digest` + `prev_digest`) जो एक अपेंड-ओनली हैश श्रृंखला बनाता है जिसे `dogfood ingest --verify-chain` पूरी तरह से ऑफ़लाइन सत्यापित करता है — यह बाहरी छेड़छाड़, डिस्क भ्रष्टाचार और आंशिक पुनर्स्थापना का पता लगाता है। यह स्वयं इनजेस्ट क्रेडेंशियल के खिलाफ सुरक्षा नहीं करता है, जो एक रिकॉर्ड और श्रृंखला दोनों को फिर से लिख सकता है; इसके लिए लेखक के नियंत्रण से बाहर एक एंकर की आवश्यकता होती है। एक **वैकल्पिक, डिफ़ॉल्ट रूप से बंद XRPL एंकर** (`dogfood ingest --anchor-*`) श्रृंखला के शीर्ष को सार्वजनिक XRP लेज़र पर दर्ज करता है, जिससे एंकर किए गए बिंदु से नीचे किसी भी प्रकार की छेड़छाड़ या पुनर्लेखन का पता लगाया जा सकता है — यह दूसरा प्रकटीकृत गैर-GitHub कॉल है, और केवल तभी जब ऑपरेटर इसे सक्षम करे।

**टेस्टिंग-ओएस क्या छूता है:** प्रत्येक `repository_dispatch` पेलोड में सबमिशन JSON; इस रिपॉजिटरी में `नीतियों/`, `फिक्स्चर/`, `रिकॉर्ड/` और `इंडेक्स/`; प्रोवेनैंस सत्यापन के लिए `api.github.com` पर आउटबाउंड कॉल।

**टेस्टिंग-ओएस क्या नहीं छूता है:** उपभोक्ता स्रोत कोड, उपभोक्ता रिपॉजिटरी में प्रेषण लिफाफे से परे रहस्य, या इस रिपॉजिटरी के कार्यक्षेत्र के बाहर कुछ भी।

**नेटवर्क सतह।** डिफ़ॉल्ट रूप से, एकमात्र आउटगोइंग कनेक्शन `api.github.com` (केवल पढ़ने के लिए उत्पत्ति) है। दो अपवाद वैकल्पिक हैं और ऊपर बताए गए हैं: एक GitLab-प्रदाता सबमिशन (`gitlab.com/api`), और ऑपरेटर द्वारा सक्षम XRPL एंकर रन। **कोई टेलीमेट्री नहीं, कोई एनालिटिक्स नहीं — यह कोडबेस कभी भी स्वचालित रूप से डेटा नहीं भेजता; उन दो वैकल्पिक रास्तों के अभाव में, यह GitHub से परे किसी भी नेटवर्क सतह को उजागर नहीं करता है।** रिसीवर वर्कफ़्लो केवल इस रिपॉजिटरी तक सीमित `contents: write` स्कोप के साथ चलता है।

## पैकेज

| पैकेज | स्रोत | उद्देश्य |
|---------|--------|---------|
| `@dogfood-lab/schemas` | टाइपस्क्रिप्ट | 8 JSON स्कीमा (रिकॉर्ड, निष्कर्ष, पैटर्न, सिफारिश, सिद्धांत, नीति, परिदृश्य, सबमिशन)। |
| `@dogfood-lab/verify` | JS | केंद्रीय सबमिशन सत्यापनकर्ता। सबमिशन यहां से गुजरते हैं इससे पहले कि उन्हें बनाए रखा जाए। |
| `@dogfood-lab/findings` | JS | निष्कर्ष अनुबंध + प्राप्त करें/समीक्षा करें/संश्लेषण करें/सलाह पाइपलाइन। |
| `@dogfood-lab/ingest` | JS | पाइपलाइन गोंद: प्रेषण → सत्यापित करें → बनाए रखें → अनुक्रमित करें। |
| `@dogfood-lab/report` | JS | स्रोत रिपॉजिटरी के लिए सबमिशन बिल्डर। |
| `@dogfood-lab/portfolio` | JS | क्रॉस-रिपॉजिटरी पोर्टफोलियो जनरेटर। |
| `@dogfood-lab/dogfood-swarm` | JS | 10-चरण समानांतर-एजेंट प्रोटोकॉल + SQLite नियंत्रण विमान + `स्वार्म` बिन। |

भाई परीक्षण उपकरण जो **स्वतंत्र रहते हैं** लेकिन प्रकाशित एपीआई के माध्यम से एकीकृत होते हैं: [`शिपचेक`](https://github.com/mcp-tool-shop-org/shipcheck), [`रिपो-नॉलेज`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`एआई-आईज-एमसीपी`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`टेस्ट-इंजन`](https://github.com/mcp-tool-shop-org/taste-engine), [`स्टाइल-डेटासेट-लैब`](https://github.com/mcp-tool-shop-org/style-dataset-lab)।

## लेआउट

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml
```

## स्थानीय विकास

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

इसके लिए नोड ≥ 22 की आवश्यकता है। सीआई मैट्रिक्स `उबंटू-नवीनतम` पर नोड 22 + 24 चलाता है; स्थानीय रूप से नोड 25 पर मान्य किया गया।

**समर्थित फ़ाइल सिस्टम:** एपीएफएस, एचएफएस+, एक्सटी4 (सीआई आधार), एनटीएफएस - कोई भी जो पीओएसआईएक्स `लिंक(2)` को लागू करता है। **समर्थित नहीं:** एक्सएफएटी, एफएटी32। [`पैकेजेस/फाइंडिंग्स/लिब/फाइल-लॉक.जेएस`](packages/findings/lib/file-lock.js) में फ़ाइल-लॉक सीएएस को परमाणु प्रकाशन के लिए हार्डलिंक सिमेंटिक्स की आवश्यकता होती है; एक्सएफएटी पर, `लिंकसिंक` `ईएनओटीएसयूपी` त्रुटि देता है (जोरदार, मौन नहीं)। एक आम समस्या: क्रॉस-प्लेटफ़ॉर्म बाहरी एसएसडी अक्सर एक्सएफएटी में स्वरूपित होते हैं - इसके बजाय स्थानीय एपीएफएस/एचएफएस+ पर रिपॉजिटरी को क्लोन करें। पूर्ण सत्र जी सत्यापन मैट्रिक्स के लिए [`डॉक्स/एम5-वैलिडेशन-2026-04-29.एमडी`](docs/m5-validation-2026-04-29.md) देखें।

## संस्करण नियंत्रण

सभी `@dogfood-lab/*` पैकेज एक साथ अपडेट होते हैं — पूरे मोनोरेपो में एक ही संस्करण संख्या। छह पैकेज v1.8.0 पर npm पर `@dogfood-lab` के तहत प्रकाशित होते हैं (क्रमबद्ध रूप से: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); सातवां, `@dogfood-lab/portfolio`, आंतरिक बना रहता है। इस रीडमी के शीर्ष के पास संस्करण पंक्ति को प्रत्येक `npm run build` पर [`scripts/sync-version.mjs`](scripts/sync-version.mjs) के माध्यम से `package.json` से स्वचालित रूप से जोड़ा जाता है।

## लाइसेंस

[एमआईटी](LICENSE) © 2026 एमसीपी-टूल-शॉप

---

<div align="center">

**[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** · **[सभी रिपॉजिटरी](https://github.com/orgs/dogfood-lab/repositories)** · **[प्रोफ़ाइल](https://github.com/dogfood-lab)**

*पहले खाओ, फिर शिप करो।*

</div
