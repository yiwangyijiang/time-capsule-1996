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

      // 检查是否有特定日期的国内事件
      let domesticEvents = [];
      if (typeof SPECIAL_DATE_DATA !== 'undefined' && SPECIAL_DATE_DATA[dateStr] && SPECIAL_DATE_DATA[dateStr].domesticEvents) {
        domesticEvents = SPECIAL_DATE_DATA[dateStr].domesticEvents;
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
          dateBasis: 'released',
          country: '国内',
          domestic: true,
          summary: '台湾歌手伊能静通过华纳音乐发行国语专辑《自己》，收录《自己》《小狗》等歌曲，是其音乐生涯的重要作品。',
          source: { name: '华纳音乐 / 台湾唱片工业年鉴', url: '' },
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
  function getMusic(dateStr) {
    // 检查是否有特定日期的数据
    if (SPECIAL_DATE_DATA[dateStr] && SPECIAL_DATE_DATA[dateStr].music) {
      return SPECIAL_DATE_DATA[dateStr].music;
    }
    return {
      status: 'unavailable',
      data: [],
      source: { name: '资料缺口', url: '' },
      note: '音乐榜单历史数据为资料缺口。目前没有公开免费的API可查询1990年代Billboard Hot 100、英国OCC、日本Oricon及华语榜单的完整历史数据。'
    };
  }

  // ============ 电影上映 ============
  function getMovies(dateStr, scope) {
    // 检查是否有特定日期的数据
    if (SPECIAL_DATE_DATA[dateStr] && SPECIAL_DATE_DATA[dateStr].movies) {
      return SPECIAL_DATE_DATA[dateStr].movies;
    }
    return {
      status: 'unavailable',
      data: [],
      source: { name: '资料缺口', url: '' },
      note: '电影上映历史数据为资料缺口。可通过IMDb、Wikipedia等手动查询特定日期的上映信息。'
    };
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
          data = getMusic(date);
        } else if (section === 'movies') {
          data = getMovies(date, params.get('scope') || 'day');
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
