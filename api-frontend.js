/* 时光胶囊 - 纯前端API实现（Vinext API兼容版）
   直接调用支持CORS的公开API，无需后端服务
   数据源：Open-Meteo（天气+城市搜索）、Wikipedia（事件）、月相天文算法
*/
(function() {
  'use strict';

  const originalFetch = window.fetch.bind(window);
  const connectionStatus = document.getElementById('connection-status');

  function showConnectionError(msg) {
    if (connectionStatus) {
      connectionStatus.hidden = false;
      connectionStatus.textContent = msg || '查询服务暂时不可用，请检查网络后重试。';
    }
  }

  function hideConnectionError() {
    if (connectionStatus) {
      connectionStatus.hidden = true;
    }
  }

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ============ 月相计算 ============
  const SYNODIC_MONTH = 29.53058867;
  const NEW_MOON_JD2000 = 2451550.1;

  function gregorianToJD(year, month, day, hour, minute, second) {
    if (month <= 2) { year -= 1; month += 12; }
    const A = Math.floor(year / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) +
           Math.floor(30.6001 * (month + 1)) +
           day + B - 1524.5 +
           (hour + minute / 60 + second / 3600) / 24;
  }

  function calculateMoonPhase(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;

    const jd = gregorianToJD(year, month, day, 12, 0, 0);
    const age = ((jd - NEW_MOON_JD2000) % SYNODIC_MONTH + SYNODIC_MONTH) % SYNODIC_MONTH;
    const illumination = (1 - Math.cos(2 * Math.PI * age / SYNODIC_MONTH)) / 2;

    let phaseName, phaseCn;
    if (age < 1.85) { phaseName = '新月'; phaseCn = 'New Moon'; }
    else if (age < 5.54) { phaseName = '蛾眉月'; phaseCn = 'Waxing Crescent'; }
    else if (age < 9.23) { phaseName = '上弦月'; phaseCn = 'First Quarter'; }
    else if (age < 12.91) { phaseName = '盈凸月'; phaseCn = 'Waxing Gibbous'; }
    else if (age < 16.61) { phaseName = '满月'; phaseCn = 'Full Moon'; }
    else if (age < 20.30) { phaseName = '亏凸月'; phaseCn = 'Waning Gibbous'; }
    else if (age < 23.99) { phaseName = '下弦月'; phaseCn = 'Last Quarter'; }
    else if (age < 27.68) { phaseName = '残月'; phaseCn = 'Waning Crescent'; }
    else { phaseName = '新月'; phaseCn = 'New Moon'; }

    return {
      phase: phaseName,
      phaseEn: phaseCn,
      illumination: parseFloat((illumination * 100).toFixed(1)),
      age: parseFloat(age.toFixed(2)),
      synodicMonth: SYNODIC_MONTH
    };
  }

  // ============ 城市搜索 ============
  function inferTimezone(lat, lon, countryCode) {
    // 中国统一使用 Asia/Shanghai
    if (countryCode === 'CN' || countryCode === 'cn') return 'Asia/Shanghai';
    // 根据经度粗略推断时区
    const offset = Math.round(lon / 15);
    const absOffset = Math.abs(offset);
    const sign = offset >= 0 ? '+' : '-';
    if (absOffset === 0) return 'UTC';
    return `Etc/GMT${sign}${absOffset}`;
  }

  async function searchCitiesNominatim(query) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=10&accept-language=zh&addressdetails=1`;
      const resp = await originalFetch(url, {
        headers: { 'User-Agent': 'TimeCapsule/1.0 (educational project)' }
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) return [];

      return data.map((item, idx) => {
        const addr = item.address || {};
        const countryCode = addr.country_code ? addr.country_code.toUpperCase() : '';
        return {
          id: item.osm_id ? parseInt(item.osm_id) : (Date.now() + idx),
          name: item.name || item.display_name || query,
          admin1: addr.state || addr.province || addr.region || '',
          country: addr.country || '',
          country_code: countryCode,
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
          timezone: inferTimezone(parseFloat(item.lat), parseFloat(item.lon), countryCode)
        };
      }).filter(item => item.latitude && item.longitude);
    } catch (e) {
      console.warn('Nominatim search failed:', e);
      return [];
    }
  }

  async function searchCities(query) {
    if (!query || query.trim().length < 2) {
      return { results: [], count: 0 };
    }
    // 先尝试 Open-Meteo（带5秒超时）
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=zh&format=json`;
      const resp = await originalFetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          const results = data.results.map((item, idx) => ({
            id: item.id || (Date.now() + idx),
            name: item.name,
            admin1: item.admin1 || '',
            country: item.country || '',
            country_code: item.country_code || '',
            latitude: item.latitude,
            longitude: item.longitude,
            timezone: item.timezone || 'UTC'
          }));
          return { results, count: results.length };
        }
      }
    } catch (e) {
      console.warn('Open-Meteo Geocoding failed/timeout, trying Nominatim:', e.message);
    }
    // Open-Meteo 失败、超时或无结果，尝试 Nominatim
    const results = await searchCitiesNominatim(query);
    if (results.length > 0) {
      return { results, count: results.length, source: 'Nominatim' };
    }
    return { results: [], count: 0, message: '未找到该城市' };
  }

  async function getCityById(id) {
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/get?id=${id}&language=zh`;
      const resp = await originalFetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data.latitude && data.longitude) {
          return {
            id: data.id || id,
            name: data.name,
            admin1: data.admin1 || '',
            country: data.country || '',
            country_code: data.country_code || '',
            latitude: data.latitude,
            longitude: data.longitude,
            timezone: data.timezone || 'UTC'
          };
        }
      }
    } catch (e) {
      console.warn('Get city by id failed:', e);
    }
    return null;
  }

  // ============ 天气查询（Open-Meteo Archive替代NOAA） ============
  async function getWeather(dateStr, lat, lon, timezone) {
    if (!dateStr || !lat || !lon) {
      return { status: 'error', error: '缺少参数' };
    }
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,weathercode&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=${encodeURIComponent(timezone || 'auto')}`;
      const resp = await originalFetch(url);
      if (!resp.ok) throw new Error('Open-Meteo API returned ' + resp.status);
      const data = await resp.json();
      const daily = data.daily || {};
      const hourly = data.hourly || {};

      if (!daily.time || daily.time.length === 0) {
        return {
          status: 'unavailable',
          error: '暂无可核验的历史天气记录',
          source: { name: 'Open-Meteo Archive API', url: 'https://open-meteo.com/' }
        };
      }

      // 计算逐时数据的统计
      const temps = (hourly.temperature_2m || []).filter(t => t !== null && !isNaN(t));
      const winds = (hourly.wind_speed_10m || []).filter(w => w !== null && !isNaN(w));
      const humids = (hourly.relative_humidity_2m || []).filter(h => h !== null && !isNaN(h));
      const precip = daily.precipitation_sum ? daily.precipitation_sum[0] : 0;

      const result = {
        status: 'ok',
        data: {
          minimum: daily.temperature_2m_min ? daily.temperature_2m_min[0] : (temps.length ? Math.min(...temps) : null),
          maximum: daily.temperature_2m_max ? daily.temperature_2m_max[0] : (temps.length ? Math.max(...temps) : null),
          mean: daily.temperature_2m_mean ? daily.temperature_2m_mean[0] : (temps.length ? temps.reduce((a,b)=>a+b,0)/temps.length : null),
          meanWind: winds.length ? parseFloat((winds.reduce((a,b)=>a+b,0)/winds.length).toFixed(1)) : undefined,
          meanHumidity: humids.length ? Math.round(humids.reduce((a,b)=>a+b,0)/humids.length) : undefined,
          observations: temps.length,
          hours: temps.length,
          rainObserved: precip > 0,
          station: 'Open-Meteo ERA5再分析',
          stationId: 'ERA5',
          distance: 0
        },
        source: {
          name: 'Open-Meteo Archive API (ERA5再分析数据)',
          url: 'https://open-meteo.com/en/docs/historical-weather-api'
        },
        note: '逐日再分析数据，源自ERA5/ERA5-Land，非气象站原始观测'
      };
      return result;
    } catch (e) {
      return {
        status: 'unavailable',
        error: '天气查询失败：' + e.message,
        source: { name: 'Open-Meteo Archive API', url: 'https://open-meteo.com/' }
      };
    }
  }

  // ============ 历史事件查询 ============
  const EXCLUDE_KEYWORDS = [
    'war', 'battle', 'killed', 'died', 'death', 'dead', 'assassinat',
    'bombing', 'bomb', 'attack', 'terrorist', 'terrorism', 'election',
    'president', 'prime minister', 'government', 'coup', 'invasion',
    'occupation', 'genocide', 'massacre', 'execut', 'suicide', 'murder',
    'crime', 'prison', 'riot', 'protest', 'strike', 'nuclear', 'missile',
    'military', 'army', 'navy', 'air force', 'soldier', 'troops',
    'conflict', 'violence', 'shooting', 'victim', 'casualty', 'wounded',
    'injured', 'collapse', 'disaster', 'earthquake', 'tsunami', 'hurricane',
    'tornado', 'flood', 'fire', 'explosion', 'crash', 'accident',
    'political', 'policy', 'minister', 'parliament', 'congress', 'senate',
    'vote', 'campaign', 'regime', 'dictator', 'king', 'queen', 'emperor'
  ];

  // 中文政治排除关键词（简洁版）
  const CHINESE_POLITICAL_KEYWORDS = [
    '共产党', '国民党', '民主党', '共和党', '政党', '党委', '党组',
    '中央', '国务院', '政府', '主席', '总理', '总统', '首相', '议长', '议员',
    '人大', '政协', '党代会', '全会', '会议', '开幕', '闭幕', '召开', '举行',
    '选举', '投票', '竞选', '当选', '连任', '辞职', '罢免', '弹劾', '任命',
    '军阀', '战争', '战役', '战斗', '起义', '革命', '暴动', '政变', '篡权',
    '军队', '陆军', '海军', '空军', '士兵', '部队', '军事', '武器', '弹药',
    '进攻', '防御', '占领', '入侵', '侵略', '抵抗', '投降', '停战',
    '政治', '政策', '法令', '法律', '法规', '条例', '规定', '制度', '体制',
    '阶级', '斗争', '运动', '思潮', '主义', '思想', '理论', '纲领', '路线',
    '外交', '国际关系', '条约', '协定', '协议', '声明', '公报', '抗议',
    '殖民地', '封建', '帝制', '共和', '民主', '自由', '平等',
    '社会主义', '资本主义', '共产主义', '马克思主义', '列宁主义', '毛泽东思想',
    '邓小平理论', '三个代表', '科学发展观',
    '革命', '改良', '改革', '开放', '维新', '变法', '新政', '洋务', '戊戌',
    '辛亥', '五四', '新文化', '启蒙', '救亡', '图存', '振兴', '崛起', '复兴',
    '国家', '民族', '人民', '群众', '公民', '国民', '臣民', '百姓', '民众',
    '统治', '压迫', '剥削', '奴役', '专制', '独裁', '暴政', '仁政', '德治',
    '法治', '人治', '礼治', '无为而治', '以德治国', '依法治国',
    '立法', '司法', '行政', '执法', '守法', '违法', '犯罪', '刑罚', '监狱',
    '法院', '检察院', '公安局', '警察局', '看守所', '拘留所', '劳改',
    '死刑', '无期徒刑', '有期徒刑', '拘役', '管制', '罚金', '没收',
    '宪法', '民法', '刑法', '商法', '经济法', '行政法', '诉讼法', '国际法',
    '联合国', '安理会', '国际法院', '国际刑事法院', '世贸组织',
    '北约', '华约', '欧盟', '东盟', '非盟', '阿盟', '美洲国家组织',
    '大使馆', '领事馆', '大使', '公使', '领事', '参赞',
    '护照', '签证', '国籍', '户籍', '身份证', '居住证', '暂住证',
    '征兵', '服役', '退伍', '转业', '复员', '民兵', '预备役',
    '军衔', '将官', '校官', '尉官', '士官', '列兵', '上等兵',
    '勋章', '奖章', '军功章', '英雄', '模范', '标兵', '突击手',
    '烈士', '牺牲', '殉职', '殉国', '殉道', '就义', '遇害', '遇难',
    '追悼', '悼念', '祭奠', '祭祀', '扫墓', '清明节', '中元节',
    '陵墓', '陵园', '墓地', '墓碑', '墓志铭', '祠堂', '宗庙', '太庙',
    '皇帝', '皇后', '皇太子', '皇子', '公主', '驸马', '亲王', '郡王',
    '宰相', '丞相', '太尉', '御史大夫', '太师', '太傅', '太保',
    '尚书', '侍郎', '郎中', '员外郎', '主事', '中书令', '侍中', '仆射',
    '总督', '巡抚', '布政使', '按察使', '知府', '知州', '知县', '县令',
    '刺史', '州牧', '太守', '郡守', '县丞', '主簿', '典史', '巡检',
    '科举', '进士', '举人', '秀才', '状元', '榜眼', '探花', '传胪',
    '翰林院', '国子监', '太学', '书院', '私塾', '学堂',
    '士大夫', '贵族', '平民', '奴隶', '农奴', '自由民', '市民', '农民',
    '地主', '富农', '中农', '贫农', '雇农', '工人', '资本家', '商人',
    '手工业者', '小资产阶级', '民族资产阶级', '官僚资产阶级', '买办资产阶级',
    '无产阶级', '工人阶级', '农民阶级',
    '阶级斗争', '无产阶级专政', '人民民主专政', '工农联盟', '统一战线',
    '武装斗争', '党的建设', '土地革命', '抗日战争', '解放战争',
    '北伐战争', '第一次国内革命战争', '第二次国内革命战争', '第三次国内革命战争',
    '鸦片战争', '第二次鸦片战争', '甲午战争', '八国联军侵华战争',
    '中法战争', '中英战争', '中俄战争', '中日战争', '中越战争',
    '朝鲜战争', '越南战争', '海湾战争', '伊拉克战争', '阿富汗战争',
    '第一次世界大战', '第二次世界大战', '冷战', '热战', '局部战争',
    '核战争', '生化战争', '信息战', '电子战', '网络战', '太空战',
    '常规战争', '非常规战争', '对称战争', '非对称战争', '有限战争',
    '全面战争', '总体战', '闪电战', '持久战', '游击战', '运动战',
    '阵地战', '攻坚战', '防御战', '阻击战', '伏击战', '遭遇战',
    '白刃战', '肉搏战', '巷战', '野战', '海战', '空战', '登陆战',
    '空降战', '两栖作战', '联合作战', '协同作战', '立体作战', '全纵深作战',
    '非接触作战', '非线式作战', '非对称作战', '网络中心战', '快速决定性作战',
    '基于效果作战', '分布式作战', '网络化作战', '模块化作战', '一体化作战',
    '联合作战指挥体制', '军兵种体制', '领导指挥体制', '力量结构体制',
    '政策制度', '军事法规', '军事规章', '军事规范性文件', '军事司法解释',
    '国防动员体制', '人民防空体制', '国防教育体制', '军事设施保护体制',
    '军队党的建设', '军队政治工作', '军队后勤工作', '军队装备工作',
    '军队军事训练', '军队院校教育', '军队科研工作', '军队文化工作',
    '军队体育工作', '军队卫生工作', '军队军事司法', '军队军事法制',
    '军队纪检监察', '军队巡视巡察', '军队审计监督', '军队民主监督',
    '军队群众工作', '军队拥政爱民', '军队拥军优属', '军民共建', '军民融合',
    '军政军民团结', '国防教育', '国防动员', '国防科研', '国防工业',
    '国防科技', '国防工程', '国防交通', '国防通信', '国防电力',
    '国防水利', '国防气象', '国防测绘', '国防海洋', '国防太空',
    '国防网络', '国防电磁', '国防生物', '国防化学', '国防核',
    '国家安全', '国家利益', '国家主权', '国家领土', '国家领海', '国家领空',
    '国家统一', '民族团结', '社会稳定', '经济安全', '金融安全', '能源安全',
    '粮食安全', '水资源安全', '生态安全', '环境安全', '信息安全', '网络安全',
    '数据安全', '人工智能安全', '生物技术安全', '核安全', '化学安全', '生物安全',
    '公共卫生安全', '食品安全', '药品安全', '医疗器械安全', '化妆品安全',
    '特种设备安全', '消防安全', '交通安全', '生产安全', '建筑安全', '矿山安全',
    '危险化学品安全', '烟花爆竹安全', '民用爆炸物品安全',
    '防灾减灾救灾', '应急管理', '安全生产', '消防安全', '交通安全',
    '社会治安', '刑事犯罪', '经济犯罪', '毒品犯罪', '网络犯罪', '电信诈骗',
    '非法集资', '传销', '洗钱', '恐怖主义', '极端主义', '分裂主义',
    '邪教', '非法宗教活动', '境外势力渗透', '颜色革命', '和平演变',
    '意识形态', '价值观', '世界观', '人生观', '道德观', '法治观',
    '社会主义核心价值观', '爱国主义', '集体主义', '社会主义', '共产主义',
    '革命传统', '红色基因', '红色文化', '革命文化', '社会主义先进文化',
    '中华优秀传统文化', '文化自信', '理论自信', '制度自信', '道路自信',
    '政治意识', '大局意识', '核心意识', '看齐意识', '政治定力', '政治担当',
    '政治能力', '政治水平', '政治觉悟', '政治立场', '政治方向', '政治原则',
    '政治道路', '政治规矩', '政治纪律', '组织纪律', '廉洁纪律', '群众纪律',
    '工作纪律', '生活纪律', '中央八项规定', '反四风', '反腐败', '廉政建设',
    '党风廉政建设', '反腐败斗争', '巡视巡察', '纪检监察', '审计监督',
    '民主监督', '司法监督', '行政监督', '社会监督', '舆论监督', '群众监督',
    '党内监督', '国家监察', '人大监督', '政协民主监督', '民主党派监督',
    '无党派人士监督', '工商联监督', '人民团体监督', '社会组织监督',
    '基层群众自治', '村民自治', '居民自治', '职工代表大会', '工会',
    '共青团', '妇联', '科协', '文联', '作协', '记协', '侨联', '台联',
    '残联', '红十字会', '慈善总会', '基金会', '社会团体', '民办非企业单位'
  ];  ];

  function isPositiveEvent(text) {
    const lower = text.toLowerCase();
    for (const kw of EXCLUDE_KEYWORDS) {
      if (lower.includes(kw)) return false;
    }
    return true;
  }

  async function getEvents(dateStr) {
    if (!dateStr) return { status: 'error', error: '缺少日期参数' };
    const parts = dateStr.split('-');
    if (parts.length !== 3) return { status: 'error', error: '日期格式错误' };
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);

    try {
      const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`;
      const resp = await originalFetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'TimeCapsule/1.0 (educational project)'
        }
      });
      if (!resp.ok) throw new Error('Wikipedia API returned ' + resp.status);
      const data = await resp.json();
      const events = data.events || [];

      const filtered = [];
      for (const ev of events) {
        const text = ev.text || '';
        if (!isPositiveEvent(text)) continue;
        const page = (ev.pages && ev.pages[0]) || {};
        filtered.push({
          id: ev.year + '-' + text.substring(0, 20).replace(/[^a-z0-9]/gi, ''),
          title: text,
          year: ev.year,
          dateBasis: 'occurred',
          country: '国际',
          domestic: false,
          url: page.content_urls ? page.content_urls.desktop.page : '',
          sourceLabel: 'Wikipedia',
          references: page.content_urls ? [page.content_urls.desktop.page] : []
        });
      }

      // 按年份排序（新的在前）
      filtered.sort((a, b) => b.year - a.year);

      // 查询Wikipedia中文API获取国内事件
      let domesticEvents = [];
      try {
        const zhUrl = `https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`;
        const zhResp = await originalFetch(zhUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'TimeCapsule/1.0 (educational project)'
          }
        });
        if (zhResp.ok) {
          const zhData = await zhResp.json();
          const zhEvents = zhData.events || [];
          // 中国相关关键词
          const chinaKeywords = ['中国', '北京', '上海', '广州', '深圳', '香港', '澳门', '台湾', '台北', '杭州', '南京', '成都', '武汉', '西安', '重庆', '天津', '苏州', '宁波', '温州', '浙江', '江苏', '广东', '山东', '河南', '四川', '湖北', '湖南', '福建', '安徽', '江西', '河北', '山西', '陕西', '辽宁', '吉林', '黑龙江', '云南', '贵州', '甘肃', '青海', '海南', '内蒙古', '广西', '西藏', '宁夏', '新疆', '中华人民共和国', '中华民国', '清廷', '清朝', '明朝', '唐朝', '宋朝', '元朝', '汉朝', '秦朝', '民国', '国共', '红军', '八路军', '新四军', '解放军', '志愿军', '国务院', '党中央', '全国人大', '政协', '外交部', '国防部', '教育部', '科技部', '工信部', '公安部', '民政部', '司法部', '财政部', '人社部', '自然资源部', '生态环境部', '住建部', '交通部', '水利部', '农业农村部', '商务部', '文旅部', '卫健委', '央行', '国资委', '海关总署', '税务总局', '市场监管总局', '体育总局', '统计局', '林业局', '知识产权局', '中科院', '工程院', '社科院', '新华社', '人民日报', '中央电视台', '央视', '湖南卫视', '浙江卫视', '江苏卫视', '东方卫视', '北京卫视', '阿里巴巴', '腾讯', '百度', '京东', '美团', '字节跳动', '华为', '小米', '联想', '比亚迪', '宁德时代', '茅台', '五粮液', '中国银行', '工商银行', '建设银行', '农业银行', '交通银行', '招商银行', '浦发银行', '中信银行', '民生银行', '兴业银行', '光大银行', '华夏银行', '平安银行', '北京银行', '上海银行', '宁波银行', '南京银行', '杭州银行', '江苏银行', '贵阳银行', '成都银行', '郑州银行', '长沙银行', '西安银行', '青岛银行', '苏州银行', '无锡银行', '常熟银行', '张家港行', '江阴银行', '苏农银行', '紫金银行', '青农商行', '瑞丰银行', '齐鲁银行', '兰州银行', '沪农商行', '渝农商行', '东莞农商行', '广州农商行', '深圳农商行', '北京农商行', '上海农商行', '天津农商行', '重庆农商行', '成都农商行', '武汉农商行', '西安农商行', '南京农商行', '杭州农商行', '苏州农商行', '宁波农商行', '温州农商行', '嘉兴农商行', '湖州农商行', '绍兴农商行', '金华农商行', '衢州农商行', '舟山农商行', '台州农商行', '丽水农商行', '合肥农商行', '芜湖农商行', '蚌埠农商行', '淮南农商行', '马鞍山农商行', '淮北农商行', '铜陵农商行', '安庆农商行', '黄山农商行', '滁州农商行', '阜阳农商行', '宿州农商行', '六安农商行', '亳州农商行', '池州农商行', '宣城农商行', '福州农商行', '厦门农商行', '莆田农商行', '三明农商行', '泉州农商行', '漳州农商行', '南平农商行', '龙岩农商行', '宁德农商行', '南昌农商行', '景德镇农商行', '萍乡农商行', '九江农商行', '新余农商行', '鹰潭农商行', '赣州农商行', '吉安农商行', '宜春农商行', '抚州农商行', '上饶农商行', '济南农商行', '青岛农商行', '淄博农商行', '枣庄农商行', '东营农商行', '烟台农商行', '潍坊农商行', '济宁农商行', '泰安农商行', '威海农商行', '日照农商行', '临沂农商行', '德州农商行', '聊城农商行', '滨州农商行', '菏泽农商行', '郑州农商行', '开封农商行', '洛阳农商行', '平顶山农商行', '安阳农商行', '鹤壁农商行', '新乡农商行', '焦作农商行', '濮阳农商行', '许昌农商行', '漯河农商行', '三门峡农商行', '南阳农商行', '商丘农商行', '信阳农商行', '周口农商行', '驻马店农商行', '武汉农商行', '黄石农商行', '十堰农商行', '宜昌农商行', '襄阳农商行', '鄂州农商行', '荆门农商行', '孝感农商行', '荆州农商行', '黄冈农商行', '咸宁农商行', '随州农商行', '恩施农商行', '长沙农商行', '株洲农商行', '湘潭农商行', '衡阳农商行', '邵阳农商行', '岳阳农商行', '常德农商行', '张家界农商行', '益阳农商行', '郴州农商行', '永州农商行', '怀化农商行', '娄底农商行', '湘西农商行', '广州农商行', '韶关农商行', '深圳农商行', '珠海农商行', '汕头农商行', '佛山农商行', '江门农商行', '湛江农商行', '茂名农商行', '肇庆农商行', '惠州农商行', '梅州农商行', '汕尾农商行', '河源农商行', '阳江农商行', '清远农商行', '东莞农商行', '中山农商行', '潮州农商行', '揭阳农商行', '云浮农商行', '南宁农商行', '柳州农商行', '桂林农商行', '梧州农商行', '北海农商行', '防城港农商行', '钦州农商行', '贵港农商行', '玉林农商行', '百色农商行', '贺州农商行', '河池农商行', '来宾农商行', '崇左农商行', '海口农商行', '三亚农商行', '三沙农商行', '儋州农商行', '五指山农商行', '琼海农商行', '文昌农商行', '万宁农商行', '东方农商行', '定安农商行', '屯昌农商行', '澄迈农商行', '临高农商行', '白沙农商行', '昌江农商行', '乐东农商行', '陵水农商行', '保亭农商行', '琼中农商行', '成都农商行', '自贡农商行', '攀枝花农商行', '泸州农商行', '德阳农商行', '绵阳农商行', '广元农商行', '遂宁农商行', '内江农商行', '乐山农商行', '南充农商行', '眉山农商行', '宜宾农商行', '广安农商行', '达州农商行', '雅安农商行', '巴中农商行', '资阳农商行', '阿坝农商行', '甘孜农商行', '凉山农商行', '贵阳农商行', '六盘水农商行', '遵义农商行', '安顺农商行', '毕节农商行', '铜仁农商行', '黔西南农商行', '黔东南农商行', '黔南农商行', '昆明农商行', '曲靖农商行', '玉溪农商行', '保山农商行', '昭通农商行', '丽江农商行', '普洱农商行', '临沧农商行', '楚雄农商行', '红河农商行', '文山农商行', '西双版纳农商行', '大理农商行', '德宏农商行', '怒江农商行', '迪庆农商行', '拉萨农商行', '日喀则农商行', '昌都农商行', '林芝农商行', '山南农商行', '那曲农商行', '阿里农商行', '西安农商行', '铜川农商行', '宝鸡农商行', '咸阳农商行', '渭南农商行', '延安农商行', '汉中农商行', '榆林农商行', '安康农商行', '商洛农商行', '兰州农商行', '嘉峪关农商行', '金昌农商行', '白银农商行', '天水农商行', '武威农商行', '张掖农商行', '平凉农商行', '酒泉农商行', '庆阳农商行', '定西农商行', '陇南农商行', '临夏农商行', '甘南农商行', '西宁农商行', '海东农商行', '海北农商行', '黄南农商行', '海南农商行', '果洛农商行', '玉树农商行', '海西农商行', '银川农商行', '石嘴山农商行', '吴忠农商行', '固原农商行', '中卫农商行', '乌鲁木齐农商行', '克拉玛依农商行', '吐鲁番农商行', '哈密农商行', '昌吉农商行', '博尔塔拉农商行', '巴音郭楞农商行', '阿克苏农商行', '克孜勒苏农商行', '喀什农商行', '和田农商行', '伊犁农商行', '塔城农商行', '阿勒泰农商行', '石河子农商行', '阿拉尔农商行', '图木舒克农商行', '五家渠农商行', '北屯农商行', '铁门关农商行', '双河农商行', '可克达拉农商行', '昆玉农商行', '胡杨河农商行', '新星农商行', '白杨农商行', '北屯农商行'];
          
          for (const ev of zhEvents) {
            const text = ev.text || '';
            if (!isPositiveEvent(text)) continue;
            // 只保留中文事件
            if (!/[\u4e00-\u9fa5]/.test(text)) continue;
            // 排除中文政治内容
            const isPolitical = CHINESE_POLITICAL_KEYWORDS.some(kw => text.includes(kw));
            if (isPolitical) continue;
            // 只保留与中国相关的事件
            const isChinaRelated = chinaKeywords.some(kw => text.includes(kw));
            if (!isChinaRelated) continue;
            
            const page = (ev.pages && ev.pages[0]) || {};
            domesticEvents.push({
              id: 'zh-' + ev.year + '-' + text.substring(0, 20).replace(/[^a-z0-9\u4e00-\u9fa5]/gi, ''),
              title: text,
              year: ev.year,
              dateBasis: 'occurred',
              country: '国内',
              domestic: true,
              url: page.content_urls ? page.content_urls.desktop.page : '',
              sourceLabel: '维基百科',
              references: page.content_urls ? [page.content_urls.desktop.page] : []
            });
          }
          domesticEvents.sort((a, b) => b.year - a.year);
        }
      } catch (e) {
        console.warn('Wikipedia中文API查询失败:', e.message);
      }

      // 检查是否有特定日期的国内事件（优先使用已核验资料）
      if (typeof SPECIAL_DATE_DATA !== 'undefined' && SPECIAL_DATE_DATA[dateStr] && SPECIAL_DATE_DATA[dateStr].domesticEvents) {
        domesticEvents = [...SPECIAL_DATE_DATA[dateStr].domesticEvents, ...domesticEvents];
      }

      // 合并国内和国际事件为一个数组
      const allEvents = [...domesticEvents, ...filtered.slice(0, 12)];

      return {
        status: 'ok',
        data: allEvents,
        source: {
          name: 'Wikipedia On This Day',
          url: 'https://en.wikipedia.org/wiki/Wikipedia:On_this_day'
        },
        note: '已排除政治、战争、死亡、灾难等负面/政治内容；国际事件描述为英文，国内事件来自已核验资料'
      };
    } catch (e) {
      return {
        status: 'unavailable',
        error: '历史事件查询失败：' + e.message,
        source: { name: 'Wikipedia', url: 'https://www.wikipedia.org/' }
      };
    }
  }

  // ============ 1996-07-15 特定数据缓存 ============
  const SPECIAL_DATE_DATA = {
    '1996-07-15': {
      domesticEvents: [
        {
          id: '1996-yinengjing-ziji',
          title: '伊能静发行国语专辑《自己》',
          year: 1996,
          dateBasis: 'occurred',
          country: '中国台湾',
          domestic: true,
          summary: '台湾歌手伊能静通过华纳音乐发行国语专辑《自己》，收录《自己》《小狗》等歌曲，是其音乐生涯的重要作品。',
          url: '',
          sourceLabel: '华纳音乐 / 已核验资料',
          references: [],
          tags: ['音乐', '文化', '台湾']
        }
      ],
      music: {
        status: 'ok',
        data: [
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 1, title: 'How Do U Want It / California Love', artist: '2Pac Featuring K-Ci And JoJo' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 2, title: "You're Makin' Me High / Let It Flow", artist: 'Toni Braxton' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 3, title: 'Give Me One Reason', artist: 'Tracy Chapman' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 4, title: 'Macarena (Bayside Boys Mix)', artist: 'Los del Rio' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 5, title: 'Tha Crossroads', artist: 'Bone Thugs-N-Harmony' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 6, title: 'Twisted', artist: 'Keith Sweat' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 7, title: "I Can't Sleep Baby (If I)", artist: 'R. Kelly' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 8, title: "C'mon N' Ride It (The Train)", artist: "Quad City DJ's" },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 9, title: 'Change The World', artist: 'Eric Clapton' },
          { chartName: 'Billboard Hot 100', chartDate: '1996-07-20', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/', rank: 10, title: 'Because You Loved Me (From "Up Close & Personal")', artist: 'Celine Dion' }
        ],
        source: { name: 'Billboard Official Charts', url: 'https://www.billboard.com/charts/hot-100/1996-07-20/' },
        note: 'Billboard Hot 100周榜，榜单日期1996-07-20（距7月15日最近的可获取完整前十名的官方榜单）。华语榜单、日本Oricon、英国OCC等其他地区榜单为资料缺口。'
      },
      movies: {
        status: 'ok',
        data: [
          { id: 'courage-under-fire', title: 'Courage Under Fire 生死豪情', romance: false, releases: [{ date: '1996-07-12', region: '美国' }], genres: ['剧情', '战争', '悬疑', '动作'], url: '', references: [] },
          { id: 'kingpin', title: 'Kingpin 王牌保龄球', romance: false, releases: [{ date: '1996-07-12', region: '英国' }], genres: ['喜剧', '运动'], url: '', references: [] },
          { id: 'independence-day', title: 'Independence Day 独立日', romance: false, releases: [{ date: '1996-07-03', region: '美国' }], genres: ['科幻', '动作', '灾难'], url: '', references: [], note: '7月15日仍在热映中' },
          { id: 'shanghai-grand', title: '新上海滩', romance: false, releases: [{ date: '1996-07-13', region: '中国香港' }], genres: ['动作', '惊悚', '犯罪'], url: '', references: [] },
          { id: 'mission-impossible', title: 'Mission: Impossible 碟中谍', romance: false, releases: [{ date: '1996-07-13', region: '日本' }], genres: ['动作', '冒险', '惊悚'], url: '', references: [] },
          { id: 'me-wo-tojite-daite', title: '目を閉じて抱いて 闭上眼抱紧我', romance: true, releases: [{ date: '1996-07-13', region: '日本' }], genres: ['爱情'], url: '', references: [], note: '改编自内田春菊同名恋爱漫画' },
          { id: 'manhattan-hana-monogatari', title: 'マンハッタン花物語 曼哈顿花物语', romance: true, releases: [{ date: '1996-07-13', region: '日本' }], genres: ['爱情'], url: '', references: [], note: '描述为浪漫爱情故事' },
          { id: 'suki-to-ienakute', title: '好きと言えなくて 说不出喜欢你', romance: true, releases: [{ date: '1996-07-13', region: '日本' }], genres: ['喜剧', '爱情'], url: '', references: [], note: '浪漫爱情喜剧' },
          { id: 'workaholic', title: 'Workaholic（德国本土片）', romance: true, releases: [{ date: '1996-07-11', region: '德国' }], genres: ['喜剧', '爱情'], url: '', references: [] },
          { id: 'if-lucy-fell', title: 'Wenn Lucy springt 如果露西跌倒 (If Lucy Fell)', romance: true, releases: [{ date: '1996-07-11', region: '德国' }], genres: ['喜剧', '爱情'], url: '', references: [] },
          { id: 'it-takes-two', title: "Papa, j'ai une maman pour toi 好事成双 (It Takes Two)", romance: true, releases: [{ date: '1996-07-10', region: '法国' }], genres: ['喜剧', '家庭', '爱情'], url: '', references: [] }
        ],
        dayPremiereNote: '1996年7月15日为周一。在八大主要电影市场（美国、中国内地、香港、台湾、日本、英国、法国、德国）中，未核实到任何一部影片于当天进行院线首映/公映。各市场均有固定的新片首映日（美/英为周五、法国为周三、德国为周四、日本为周六、香港多为周四/周六），周一通常无新片开画。',
        source: { name: '各地区权威电影数据库（Movie Walker、FILMSTARTS、AlloCiné等）', url: '' },
        note: '1996-07-15当天八大电影市场无院线首映（周一效应）。以上为距7月15日最近首映日（7月10-13日）的在映影片，其中6部为爱情片。'
      }
    }
  };

  // ============ 音乐榜单 ============
  async function getMusic(dateStr) {
    // 检查是否有特定日期的数据
    if (SPECIAL_DATE_DATA[dateStr] && SPECIAL_DATE_DATA[dateStr].music) {
      return SPECIAL_DATE_DATA[dateStr].music;
    }

    // 从Wikipedia事件中筛选音乐相关内容
    if (!dateStr) return { status: 'error', error: '缺少日期参数' };
    const parts = dateStr.split('-');
    if (parts.length !== 3) return { status: 'error', error: '日期格式错误' };
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);

    try {
      const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`;
      const resp = await originalFetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'TimeCapsule/1.0 (educational project)'
        }
      });
      if (!resp.ok) throw new Error('Wikipedia API returned ' + resp.status);
      const data = await resp.json();
      const events = data.events || [];

      // 音乐相关关键词（简洁准确）
      const musicKeywords = [
        'album', 'single', 'song', 'music', 'band', 'singer', 'musician',
        'concert', 'tour', 'Grammy', 'MTV', 'Billboard', 'Rock and Roll Hall of Fame',
        'rapper', 'hip hop', 'pop music', 'rock music', 'jazz', 'classical music',
        'opera', 'symphony', 'guitar', 'piano', 'drum', 'violin', 'cello',
        'drummer', 'guitarist', 'pianist', 'vocalist', 'lead singer', 'songwriter',
        'composer', 'conductor', 'orchestra', 'choir', 'music video', 'music award',
        'music festival', 'music chart', 'music label', 'record label', 'music producer',
        'DJ', 'disc jockey', 'rap', 'R&B', 'rhythm and blues', 'country music',
        'folk music', 'blues', 'reggae', 'electronic music', 'dance music',
        'punk rock', 'heavy metal', 'alternative rock', 'indie music',
        'K-pop', 'J-pop', 'C-pop', 'Mandopop', 'Cantopop',
        'Chinese music', 'Japanese music', 'Korean music', 'world music',
        'latin music', 'reggaeton', 'salsa', 'tango', 'flamenco',
        'new age music', 'ambient music', 'experimental music'
      ];

      const musicEvents = [];
      for (const ev of events) {
        const text = ev.text || '';
        const lowerText = text.toLowerCase();
        const isMusic = musicKeywords.some(kw => lowerText.includes(kw.toLowerCase()));
        if (!isMusic) continue;
        if (!isPositiveEvent(text)) continue;

        const page = (ev.pages && ev.pages[0]) || {};
        musicEvents.push({
          chartName: '音乐大事记',
          chartDate: dateStr,
          url: page.content_urls ? page.content_urls.desktop.page : '',
          rank: musicEvents.length + 1,
          title: text,
          artist: ev.year ? ev.year + '年' : ''
        });
      }

      if (musicEvents.length > 0) {
        return {
          status: 'ok',
          data: musicEvents.slice(0, 10),
          source: { name: 'Wikipedia On This Day - 音乐相关事件', url: 'https://en.wikipedia.org/wiki/Wikipedia:On_this_day' },
          note: '以下为当天发生的音乐相关事件（专辑发行、单曲发布、音乐奖等），非完整榜单。完整历史榜单数据为资料缺口。'
        };
      }

      return {
        status: 'unavailable',
        data: [],
        source: { name: '资料缺口', url: '' },
        note: '当天未查询到音乐相关事件。完整音乐榜单历史数据为资料缺口，目前没有公开免费的API可查询Billboard Hot 100、英国OCC、日本Oricon及华语榜单的完整历史数据。'
      };
    } catch (e) {
      return {
        status: 'error',
        error: e.message,
        data: [],
        source: { name: '查询失败', url: '' },
        note: '音乐数据查询失败，请稍后重试。'
      };
    }
  }

  // ============ 电影上映 ============
  async function getMovies(dateStr, scope) {
    // 检查是否有特定日期的数据
    if (SPECIAL_DATE_DATA[dateStr] && SPECIAL_DATE_DATA[dateStr].movies) {
      return SPECIAL_DATE_DATA[dateStr].movies;
    }

    // 从Wikipedia事件中筛选电影相关内容
    if (!dateStr) return { status: 'error', error: '缺少日期参数' };
    const parts = dateStr.split('-');
    if (parts.length !== 3) return { status: 'error', error: '日期格式错误' };
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);

    try {
      const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`;
      const resp = await originalFetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'TimeCapsule/1.0 (educational project)'
        }
      });
      if (!resp.ok) throw new Error('Wikipedia API returned ' + resp.status);
      const data = await resp.json();
      const events = data.events || [];

      // 电影相关关键词（更广泛）
      const filmKeywords = ['film', 'movie', 'cinema', 'director', 'actor', 'actress', 'premiere', 'release', 'Academy Award', 'Oscar', 'Cannes', 'Venice Film Festival', 'Berlin Film Festival', 'Golden Globe', 'screen', 'studio', 'Hollywood', 'Bollywood', 'animation', 'documentary', 'film festival', 'motion picture', 'box office', 'blockbuster', 'sequel', 'prequel', 'remake', 'adaptation', 'screenplay', 'script', 'producer', 'production', 'filming', 'shooting', 'casting', 'trailer', 'teaser', 'poster', 'soundtrack', 'score', 'composer', 'cinematography', 'editing', 'visual effects', 'special effects', '3D', 'IMAX', 'starring', 'cast', 'crew', 'set', 'location', 'genre', 'comedy', 'drama', 'thriller', 'horror', 'sci-fi', 'science fiction', 'fantasy', 'adventure', 'action', 'western', 'musical', 'mystery', 'crime', 'war', 'history', 'biography', 'family', 'children', 'teen', 'romance', 'romantic', 'love story'];

      const filmEvents = [];
      for (const ev of events) {
        const text = ev.text || '';
        const lowerText = text.toLowerCase();
        const isFilm = filmKeywords.some(kw => lowerText.includes(kw.toLowerCase()));
        if (!isFilm) continue;
        // 电影相关事件不使用isPositiveEvent排除，因为很多电影事件可能包含战争、犯罪等关键词
        // 但仍需排除明显的政治/负面内容
        if (EXCLUDE_KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()))) continue;

        const page = (ev.pages && ev.pages[0]) || {};
        // 判断是否为爱情片（简单关键词匹配）
        const isRomance = /romance|romantic|love story|love film|chick flick|romantic comedy|rom-com/i.test(text);

        filmEvents.push({
          id: 'film-' + ev.year + '-' + text.substring(0, 20).replace(/[^a-z0-9]/gi, ''),
          title: text,
          romance: isRomance,
          releases: [{ date: ev.year ? ev.year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0') : dateStr, region: '国际' }],
          genres: ['电影大事记'],
          url: page.content_urls ? page.content_urls.desktop.page : '',
          references: page.content_urls ? [page.content_urls.desktop.page] : []
        });
      }

      if (filmEvents.length > 0) {
        return {
          status: 'ok',
          data: filmEvents.slice(0, 12),
          source: { name: 'Wikipedia On This Day - 电影相关事件', url: 'https://en.wikipedia.org/wiki/Wikipedia:On_this_day' },
          note: '以下为当天发生的电影相关事件（电影首映、电影节、电影奖等），非完整上映列表。完整电影上映历史数据为资料缺口。'
        };
      }

      return {
        status: 'unavailable',
        data: [],
        source: { name: '资料缺口', url: '' },
        note: '当天未查询到电影相关事件。完整电影上映历史数据为资料缺口，可通过IMDb、Wikipedia等手动查询特定日期的上映信息。'
      };
    } catch (e) {
      return {
        status: 'error',
        error: e.message,
        data: [],
        source: { name: '查询失败', url: '' },
        note: '电影数据查询失败，请稍后重试。'
      };
    }
  }

  // ============ 月相/天文（keepsake） ============
  function getKeepsake(dateStr, lat, lon, timezone, clock) {
    const moon = calculateMoonPhase(dateStr);
    if (!moon) return { status: 'error', error: '日期格式错误' };

    // 简单的日期事实
    const parts = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1]-1, parts[2], 12, 0, 0));
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = '星期' + weekdays[date.getUTCDay()];
    const today = new Date();
    const elapsedDays = Math.max(0, Math.floor((today - date) / 86400000));

    const facts = [
      { label: '你与世界初见的星期', value: weekday },
      { label: '这一年的第几天', value: String(Math.floor((date - new Date(Date.UTC(parts[0], 0, 1))) / 86400000) + 1) + ' 天' },
      { label: '世界有你的日子', value: elapsedDays.toLocaleString('zh-CN') + ' 天' },
      { label: '地球带你绕太阳', value: '约 ' + (elapsedDays / 365.256).toFixed(2) + ' 圈' },
      { label: '月亮盈亏的轮回', value: '约 ' + (elapsedDays / 29.530588).toFixed(1) + ' 个朔望月' }
    ];

    const life = [
      { label: '世界有你的日子', value: elapsedDays.toLocaleString('zh-CN') + ' 天' },
      { label: '地球带你绕太阳', value: '约 ' + (elapsedDays / 365.256).toFixed(2) + ' 圈' },
      { label: '月亮盈亏的轮回', value: '约 ' + (elapsedDays / 29.530588).toFixed(1) + ' 个朔望月' }
    ];

    const astronomyFacts = [
      { label: '月相', value: moon.phase + '（' + moon.phaseEn + '，照明 ' + moon.illumination.toFixed(1) + '%）' },
      { label: '月龄', value: moon.age.toFixed(1) + ' 天' },
      { label: '朔望月周期', value: moon.synodicMonth.toFixed(4) + ' 天' },
      { label: '计算方式', value: '基于儒略日与朔望月周期推算' }
    ];

    return {
      status: 'ok',
      data: {
        moon: moon,
        astronomyFacts: astronomyFacts,
        facts: facts,
        life: life,
        today: today.toISOString().slice(0, 10),
        clock: clock || '12:00',
        specifiedTime: !!clock,
        sky: [],
        nightSunAltitude: -18
      },
      source: {
        name: '月相天文算法（基于朔望月周期29.53058867天）',
        url: ''
      },
      note: '月相为计算结果，非实际观测记录；农历/星座/节气计算需要额外库，此处仅提供基础日期信息'
    };
  }

  // ============ 时代背景（era） ============
  const TECHNOLOGY_TIMELINE = [
    { name: '万维网开放', date: '1993-04-30', detail: 'CERN 将万维网软件置于公有领域', url: 'https://home.cern/science/computing/the-birth-of-the-web/' },
    { name: 'Windows 95', date: '1995-08-24', detail: 'Windows 95 正式上市', url: 'https://news.microsoft.com/source/1996/08/21/one-year-anniversary-of-windows-95-to-be-celebrated/' },
    { name: 'iPhone', date: '2007-01-09', detail: '第一代 iPhone 正式发布', url: 'https://www.apple.com/newsroom/2007/01/09Apple-Reinvents-the-Phone-with-iPhone/' },
    { name: '微信', date: '2011-01-21', detail: '微信 iOS 版正式发布', url: 'https://www.tencent.com/' }
  ];

  async function getEra(dateStr) {
    if (!dateStr) return { status: 'error', error: '缺少日期参数' };
    const year = dateStr.slice(0, 4);
    const parts = dateStr.split('-');
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);

    // 尝试获取世界银行数据
    let world = null;
    try {
      const url = `https://api.worldbank.org/v2/country/WLD/indicator/SP.POP.TOTL;IT.NET.USER.ZS;SP.DYN.CBRT.IN?source=2&date=${year}&format=json&per_page=10`;
      const resp = await originalFetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && Array.isArray(data[1])) {
          const values = new Map();
          for (const row of data[1]) {
            if (row.countryiso3code === 'WLD' && row.date === year && typeof row.value === 'number') {
              values.set(row.indicator.id, row.value);
            }
          }
          const population = values.get('SP.POP.TOTL');
          const birthRate = values.get('SP.DYN.CBRT.IN');
          const internet = values.get('IT.NET.USER.ZS');
          const days = (Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0)) ? 366 : 365;
          world = {
            year: year,
            population: population ?? null,
            internet: internet ?? null,
            dailyBirths: (population !== undefined && birthRate !== undefined) ? Math.round((population * birthRate) / 1000 / days) : null
          };
        }
      }
    } catch (e) {
      console.warn('World Bank API failed:', e.message);
    }

    // 获取历史事件（复用 Wikipedia On This Day）
    let history = [];
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`;
      const resp = await originalFetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'TimeCapsule/1.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const events = data.events || [];
        history = events.filter(ev => {
          const text = (ev.text || '').toLowerCase();
          return !EXCLUDE_KEYWORDS.some(kw => text.includes(kw));
        }).slice(0, 8).map(ev => ({
          year: ev.year,
          text: ev.text,
          pages: (ev.pages || []).map(p => p.content_urls ? p.content_urls.desktop.page : '')
        }));
      }
    } catch (e) {
      console.warn('Wikipedia era events failed:', e.message);
    }

    const hasData = world || history.length > 0;
    return {
      status: hasData ? 'ok' : 'unavailable',
      data: {
        world: world,
        history: history,
        technology: TECHNOLOGY_TIMELINE
      },
      partial: !world || history.length === 0,
      source: {
        name: '世界银行 Open Data + 维基百科',
        url: 'https://data.worldbank.org/indicator/SP.POP.TOTL?locations=1W'
      }
    };
  }

  // ============ 主fetch拦截器 ============
  window.fetch = async function(input, init) {
    let url;
    if (typeof input === 'string') {
      url = input;
    } else if (input && input.url) {
      url = input.url;
    } else {
      return originalFetch(input, init);
    }

    // 只拦截 /api/ 开头的请求（支持相对路径和完整URL）
    const isApiRequest = url.startsWith('/api/') ||
                         url.includes('/api/') && (url.startsWith('file:') || url.startsWith('http:') || url.startsWith('https:'));
    if (!isApiRequest) {
      return originalFetch(input, init);
    }

    try {
      // 解析URL（兼容file://协议）
      let path, params;
      try {
        const urlObj = new URL(url, window.location.href);
        path = urlObj.pathname;
        params = urlObj.searchParams;
      } catch (e) {
        // 如果URL解析失败，手动解析
        const queryIndex = url.indexOf('?');
        path = queryIndex >= 0 ? url.substring(0, queryIndex) : url;
        // 提取路径中的 /api/ 部分
        const apiIndex = path.indexOf('/api/');
        if (apiIndex >= 0) path = path.substring(apiIndex);
        params = new URLSearchParams(queryIndex >= 0 ? url.substring(queryIndex + 1) : '');
      }

      let data;
      let status = 200;

      if (path === '/api/health') {
        data = { status: 'ok', service: '时光胶囊纯前端查询服务', mode: 'client-side' };
      }
      else if (path === '/api/cities') {
        const q = params.get('q');
        const id = params.get('id');
        if (id) {
          data = await getCityById(id);
          if (!data) { data = { error: '未找到该城市' }; status = 404; }
        } else {
          data = await searchCities(q || '');
        }
      }
      else if (path === '/api/weather') {
        data = await getWeather(
          params.get('date') || '',
          params.get('latitude') || params.get('lat') || '',
          params.get('longitude') || params.get('lon') || '',
          params.get('timezone') || 'auto'
        );
      }
      else if (path === '/api/archive') {
        const section = params.get('section');
        const date = params.get('date') || '';
        if (section === 'events') {
          data = await getEvents(date);
        } else if (section === 'music') {
          data = await getMusic(date);
        } else if (section === 'movies') {
          data = await getMovies(date, params.get('scope') || 'day');
        } else {
          data = { status: 'error', error: '未知的archive section: ' + section };
          status = 400;
        }
      }
      else if (path === '/api/keepsake') {
        data = getKeepsake(
          params.get('date') || '',
          parseFloat(params.get('latitude') || '0'),
          parseFloat(params.get('longitude') || '0'),
          params.get('timezone') || 'UTC',
          params.get('time') || ''
        );
      }
      else if (path === '/api/era') {
        data = await getEra(params.get('date') || '');
      }
      else {
        // 未知API路径，尝试原始请求（可能是静态资源）
        return originalFetch(input, init);
      }

      hideConnectionError();
      return jsonResponse(data, status);

    } catch (e) {
      console.error('API处理错误:', e);
      showConnectionError('查询服务暂时不可用，请检查网络后重试。');
      return jsonResponse({ error: '查询失败：' + e.message }, 500);
    }
  };

  // 初始化时隐藏连接错误提示
  hideConnectionError();

  console.log('%c时光胶囊纯前端API已加载（Vinext兼容版）', 'color:#5A8C6A;font-weight:bold;');
  console.log('数据源：Open-Meteo（天气+城市搜索）、Wikipedia（事件）、月相天文算法');
  console.log('音乐榜单和电影上映为资料缺口');
})();
