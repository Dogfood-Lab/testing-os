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
**v1.3.2** — वर्तमान संस्करण। इसमें क्या शामिल किया गया है, यह देखने के लिए [CHANGELOG.md](CHANGELOG.md) देखें।
<!-- version:end -->

📖 **[हैंडबुक पढ़ें →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## यह क्या है

`testing-os` [डॉगफूड लैब](https://github.com/dogfood-lab) गिटहब संगठन का प्रमुख मोनोरेपो है — अब संग्रहित [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) का उत्तराधिकारी। यह एआई-आधारित विकास वर्कफ़्लो में परीक्षण चलाने, रिकॉर्ड करने और उनसे सीखने के लिए प्रोटोकॉल और बुनियादी ढांचे को एक साथ जोड़ता है:

- कोडबेस के विरुद्ध समानांतर-एजेंट ऑडिट चलाने के लिए एक **स्वार्म प्रोटोकॉल**।
- उन परीक्षणों से प्राप्त रिकॉर्ड, निष्कर्ष, पैटर्न और सिफारिशों के लिए एक **साक्ष्य भंडार + स्कीमा रीढ़**।
- एक **नीति + सत्यापनकर्ता** परत जो यह तय करती है कि "सत्यापित" के रूप में क्या गिना जाता है — और उपभोक्ता रिपॉजिटरी में इसे लागू करता है।
- एक **बुद्धि परत** जो कच्चे निष्कर्षों को पुन: प्रयोज्य पैटर्न और सिद्धांत में बदल देती है।

## त्वरित शुरुआत

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

ऑपरेटर का मार्गदर्शिका, सीएलआई संदर्भ, स्कीमा संदर्भ और एकीकरण व्यंजनों **[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** में उपलब्ध हैं। प्रत्येक संस्करण के लिए विस्तृत जानकारी [CHANGELOG.md](CHANGELOG.md) में दी गई है।

## खतरा मॉडल

टेस्टिंग-ओएस `mcp-tool-shop-org/*` और `dogfood-lab/*` के तहत विश्वसनीय गिटहब रिपॉजिटरी से `repository_dispatch` के माध्यम से भेजे गए डॉगफूड सबमिशन को संसाधित करता है। सत्यापनकर्ता को गिटहब एक्शन प्रोवेनैंस की आवश्यकता होती है — दावा किए गए रन आईडी को गिटहब एपीआई के माध्यम से पुष्टि की जाती है, और गलत आकार, लापता संदर्भ या अमान्य नीति दावों वाले सबमिशन को अस्वीकार कर दिया जाता है।

**टेस्टिंग-ओएस क्या छूता है:** प्रत्येक `repository_dispatch` पेलोड में सबमिशन JSON; इस रिपॉजिटरी में `नीतियों/`, `फिक्स्चर/`, `रिकॉर्ड/` और `इंडेक्स/`; प्रोवेनैंस सत्यापन के लिए `api.github.com` पर आउटबाउंड कॉल।

**टेस्टिंग-ओएस क्या नहीं छूता है:** उपभोक्ता स्रोत कोड, उपभोक्ता रिपॉजिटरी में प्रेषण लिफाफे से परे रहस्य, या इस रिपॉजिटरी के कार्यक्षेत्र के बाहर कुछ भी।

**आवश्यक अनुमतियाँ:** रिसीवर वर्कफ़्लो केवल इस रिपॉजिटरी तक सीमित `सामग्री: लिखें` के साथ चलता है। प्रोवेनैंस सत्यापन केवल पढ़ने के लिए एक्शन एपीआई कॉल के लिए वर्कफ़्लो के डिफ़ॉल्ट `GITHUB_TOKEN` का उपयोग करता है। **कोई टेलीमेट्री नहीं, कोई तृतीय-पक्ष सेवाएँ नहीं, कोई एनालिटिक्स नहीं — यह कोडबेस न तो घर फोन करता है और न ही गिटहब से परे कोई नेटवर्क सतह उजागर करता है।**

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
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml
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

सभी `@dogfood-lab/*` पैकेज एक साथ अपडेट किए जाते हैं — मोनोरपो में एक ही संख्या। छह पैकेज v1.3.2 पर `@dogfood-lab` के तहत npm पर प्रकाशित होते हैं (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); सातवां, `@dogfood-lab/portfolio`, आंतरिक रूप से ही रहता है। इस रीडमी के शीर्ष के पास संस्करण पंक्ति को हर `npm run build` पर [`scripts/sync-version.mjs`](scripts/sync-version.mjs) के माध्यम से `package.json` से स्वचालित रूप से अपडेट किया जाता है।

## लाइसेंस

[एमआईटी](LICENSE) © 2026 एमसीपी-टूल-शॉप

---

<div align="center">

**[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** · **[सभी रिपॉजिटरी](https://github.com/orgs/dogfood-lab/repositories)** · **[प्रोफ़ाइल](https://github.com/dogfood-lab)**

*पहले खाओ, फिर शिप करो।*

</div
