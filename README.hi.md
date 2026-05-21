<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.md">English</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
</p>

<div align="center">

# ```hindi
testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**एआई युग में परीक्षण के लिए ऑपरेटिंग सिस्टम**

*एआई-सहायता प्राप्त सॉफ्टवेयर के लिए प्रोटोकॉल, साक्ष्य भंडार और सीखने के चक्र।*

**v1.2.3** — 7 पैकेज (`@dogfood-lab/*`), पूरे कार्यक्षेत्र के लिए परीक्षण सूट, 'इंजस्ट' रिसीवर लाइव, हैंडबुक तैनात।

📖 **[हैंडबुक पढ़ें →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## यह क्या है

`testing-os` [Dogfood Lab](https://github.com/dogfood-lab) गिटहब संगठन का प्रमुख मोनोरिपो है - जो अब बंद कर दिए गए [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) का उत्तराधिकारी है। यह प्रोटोकॉल और बुनियादी ढांचे को एक एआई-आधारित विकास कार्यप्रवाह में परीक्षण चलाने, रिकॉर्ड करने और उनसे सीखने के लिए एक साथ लाता है:

- एक **स्वार्म प्रोटोकॉल** जो कोडबेस के खिलाफ समानांतर एजेंट ऑडिट चलाने के लिए उपयोग किया जाता है।
- रिकॉर्ड, निष्कर्ष, पैटर्न और सिफारिशों के लिए एक **साक्ष्य भंडार + स्कीमा स्पाइन**।
- एक **नीति + सत्यापनकर्ता** परत जो यह निर्धारित करती है कि "सत्यापित" क्या है - और इसे उपभोक्ता रिपॉजिटरी में लागू करती है।
- एक **इंटेलिजेंस लेयर** जो कच्चे निष्कर्षों को पुन: प्रयोज्य पैटर्न और सिद्धांतों में बदल देती है।

## स्थिति

**v1.2.3** — 'हेल्थ-पास' को साफ करने वाला संस्करण। v1.2.2 के खिलाफ चार चरणों वाला 'डॉगफूड' परीक्षण (पहला चरण: बग/सुरक्षा → दूसरा चरण: सक्रिय सुधार → तीसरा चरण: मानवीयकरण → चौथा चरण: दृश्य सुधार) में 50 से अधिक त्रुटियां पाई गईं; इस संस्करण में महत्वपूर्ण सुधार शामिल हैं: रिसीवर पाइपलाइन के लिए सुरक्षा उपाय (`execFileSync` का तर्क रूप सत्यापन रनर में, एजेंट आउटपुट पर `JSON.parse` की सीमा, `repository_dispatch` पेलोड के लिए सुरक्षा उपाय), ऑपरेटरों के लिए उपयोगी त्रुटि संदेश (`loadGlobalPolicy` में ENOENT/YAML त्रुटियां, इंडेक्स पुनर्निर्माण विफलताओं में अब स्टैक और रिकवरी संकेत शामिल हैं), नोड-संस्करण की सत्यता जांच (README, CHANGELOG और CLAUDE.md), 17 पहले अपलेखित 'स्वार्म' क्रियाओं को कवर करने वाला एक नया CLI संदर्भ हैंडबुक पृष्ठ, एक कस्टम 404 पृष्ठ और सोशल-कार्ड मेटा। किसी भी पैकेज की संरचना में बदलाव नहीं, v1.2.2 से कोई महत्वपूर्ण बदलाव नहीं। सभी चरण 5 की विशेषताएं बरकरार हैं: वेव-स्तरीय स्टेट मशीन + तीन 'आर' रिकवरी अनुबंध (`स्वार्म रीवैलिडेट`, `स्वार्म रीवाइंड`, `स्वार्म रीड्राइव`) + `स्वार्म हिस्ट्री` ऑडिट-ट्रेल क्रिया। छह पैकेज `@dogfood-lab` के अंतर्गत प्रकाशित किए गए हैं: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. **1105/1105 परीक्षण पास हुए।** रिपॉजिटरी के जीवनकाल में (v1.0.0 से, 2026-04-25 तक): चरण 7 का 'डॉगफूड' परीक्षण (लगभग 31 वेव, लगभग 115 सत्यापित-समाधान त्रुटियां, 14 ऑडिट कवरेज वर्ग), v1.2.x का पहला npm प्रकाशन, और v1.2.3 का 'हेल्थ-पास' सफाई। आधिकारिक 'स्वार्म' कैटलॉग: [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md)।

रिसीवर लाइव है: उपभोक्ता रिपॉजिटरी में `dogfood.yml` वर्कफ़्लो इस रिपॉजिटरी पर भेजे जाते हैं, और [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) से प्राप्त रिकॉर्ड और इंडेक्स `main` में वापस प्रतिबद्ध किए जाते हैं। हैंडबुक [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) पर तैनात है। मुख्य इंस्टॉलेशन: `npm install -g @dogfood-lab/dogfood-swarm`। रिसीवर साइड को डिस्पैच के माध्यम से उपभोग किया जाता है - हैंडबुक के एकीकरण पृष्ठ देखें।

**प्लेटफ़ॉर्म:** सेशन जी ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)) के हिस्से के रूप में Darwin/APFS पर एंड-टू-एंड सत्यापन किया गया। समर्थित फ़ाइल सिस्टम के लिए [स्थानीय विकास](#local-development) देखें। प्रत्येक संस्करण का विवरण [CHANGELOG.md](CHANGELOG.md) में दिया गया है।

## खतरे का मॉडल

`testing-os` `mcp-tool-shop-org/*` और `dogfood-lab/*` के तहत विश्वसनीय गिटहब रिपॉजिटरी से `repository_dispatch` के माध्यम से भेजे गए डॉगफूड सबमिशन को संसाधित करता है। सत्यापनकर्ता को गिटहब एक्शन प्रमाण की आवश्यकता होती है - दावों वाले रन आईडी को गिटहब एपीआई के माध्यम से सत्यापित किया जाता है, और खराब आकार, गुम संदर्भ या अमान्य नीति दावों वाले सबमिशन को अस्वीकार कर दिया जाता है।

**`testing-os` क्या छूता है:** प्रत्येक `repository_dispatch` पेलोड में JSON सबमिशन; इस रिपॉजिटरी में `policies/`, `fixtures/`, `records/` और `indexes/`; प्रमाण सत्यापन के लिए `api.github.com` पर आउटबाउंड कॉल।
```

**'टेस्टिंग-ओएस' निम्नलिखित चीजों को शामिल नहीं करता:** उपभोक्ता स्रोत कोड, उपभोक्ता रिपॉजिटरी में 'डिस्पैच एनवेलप' से बाहर की कोई भी गोपनीय जानकारी, या इस रिपॉजिटरी के कार्यशील ट्री के बाहर की कोई भी चीज़।

**आवश्यक अनुमतियाँ:** रिसीवर वर्कफ़्लो `contents: write` स्कोप के साथ चलता है, जो केवल इस रिपॉजिटरी तक सीमित है। प्रामाणिकता सत्यापन, केवल-पढ़ने के लिए 'एक्शन एपीआई' कॉल के लिए वर्कफ़्लो के डिफ़ॉल्ट `GITHUB_TOKEN` का उपयोग करता है। **इसमें कोई टेलीमेट्री, कोई तृतीय-पक्ष सेवाएं, कोई विश्लेषण नहीं है - यह कोडबेस न तो किसी सर्वर से डेटा भेजता है और न ही GitHub के बाहर किसी नेटवर्क कनेक्शन का उपयोग करता है।**

## पैकेज

| पैकेज | स्रोत | उद्देश्य |
|---------|--------|---------|
| `@dogfood-lab/schemas` | टाइपस्क्रिप्ट | 8 JSON स्कीमा (रिकॉर्ड, फाइंडिंग, पैटर्न, सिफारिश, सिद्धांत, नीति, परिदृश्य, सबमिशन)। |
| `@dogfood-lab/verify` | JS | केंद्रीय सबमिशन सत्यापनकर्ता। सबमिशन यहां से गुजरते हैं, इससे पहले कि उन्हें संग्रहीत किया जाए। |
| `@dogfood-lab/findings` | JS | फाइंडिंग अनुबंध + व्युत्पन्न/समीक्षा/संश्लेषण/सलाह देने के लिए पाइपलाइन। |
| `@dogfood-lab/ingest` | JS | पाइपलाइन कनेक्शन: डिस्पैच → सत्यापित → संग्रहीत → अनुक्रमित। |
| `@dogfood-lab/report` | JS | स्रोत रिपॉजिटरी के लिए सबमिशन बिल्डर। |
| `@dogfood-lab/portfolio` | JS | क्रॉस-रिपॉजिटरी पोर्टफोलियो जनरेटर। |
| `@dogfood-lab/dogfood-swarm` | JS | 10-चरण समानांतर-एजेंट प्रोटोकॉल + SQLite नियंत्रण तल + `swarm` बाइनरी। |

समान परीक्षण उपकरण जो **स्वतंत्र रहते हैं** लेकिन प्रकाशित एपीआई के माध्यम से एकीकृत होते हैं: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)।

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

इसके लिए Node ≥ 20 की आवश्यकता है। CI मैट्रिक्स में Node 20 + 22 का उपयोग `ubuntu-latest` पर किया जाता है; स्थानीय रूप से Node 25 पर सत्यापित किया गया।

**समर्थित फ़ाइल सिस्टम:** APFS, HFS+, ext4 (CI बेसलाइन), NTFS - जो भी POSIX `link(2)` को लागू करता है। **समर्थित नहीं:** exFAT, FAT32। [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) में फ़ाइल-लॉक CAS को परमाणु प्रकाशन के लिए हार्डलिंक सिमेंटिक्स की आवश्यकता होती है; exFAT पर, `linkSync` `ENOTSUP` त्रुटि देता है (यह शांत त्रुटि नहीं है)। एक आम समस्या: क्रॉस-प्लेटफ़ॉर्म बाहरी SSD अक्सर exFAT में स्वरूपित होते हैं - स्थानीय APFS/HFS+ पर रिपॉजिटरी को क्लोन करें। सत्र जी सत्यापन मैट्रिक्स के बारे में अधिक जानकारी के लिए [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) देखें।

## संस्करण

सभी `@dogfood-lab/*` पैकेजों में एक साथ संस्करण अपडेट किया जाता है। इस README में संस्करण पंक्ति `scripts/sync-version.mjs` के माध्यम से `package.json` से स्वचालित रूप से अपडेट की जाती है (यह `prebuild` के रूप में चलता है)। **v1.2.0** के अनुसार, छह पैकेज `@dogfood-lab` स्कोप के तहत npm पर प्रकाशित होते हैं: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. सातवां पैकेज (`@dogfood-lab/portfolio`) अभी भी इस मोनोरेपो के भीतर आंतरिक है।

## लाइसेंस

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[हैंडबुक](https://dogfood-lab.github.io/testing-os/handbook/)** · **[सभी रिपॉजिटरी](https://github.com/orgs/dogfood-lab/repositories)** · **[प्रोफ़ाइल](https://github.com/dogfood-lab)**

*पहले खाओ। फिर शिप करो।*

</div
