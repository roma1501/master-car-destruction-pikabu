// ObbyChat.js — реплики ботов-«игроков» (ru / en по языку сборки): приветствия и прощания, падения (общее, лава, вода,
// ловушка), чекпоинты, болтовня, просьба о помощи + советы, вопрос про этап + ответы, финиш, реакция на игрока и на
// то, что его сбили. Без ссылок, имён сервисов и личных данных — это проверяет тест (ObbyChat.unsafe). Чистая логика:
// выбор строки зависит только от генератора случайных чисел, который отдаёт вызывающий (тесты — с зерном).
//
//   ObbyChat.pick('ru', 'hi', rng)                    -> 'всем привет!'
//   ObbyChat.pick('en', 'answer', rng, { n: 7 })      -> 'stage 7'     ({n} — этап бота, {name} — другой ник)
//   ObbyChat.add('ru', 'talk', ['свои строки'])       -> игра дописывает свои реплики (после проверки на ссылки)
//   ObbyChat.categoryFor('lava')                      -> 'fallLava'    (причина смерти ObbyCourse.killCause -> категория)
//
// Категории: hi hiReply bye | fall fallLava fallWater fallTrap | checkpoint playerCheckpoint | talk funny |
//            ask answer help helpReply | win | knocked.

/** @satisfies {Record<string, any>} */
const ObbyChat = {
    /** Язык реплик по коду языка игры: ru или en (остальное — en). */
    lang(code) { return String(code || '').toLowerCase().startsWith('ru') ? 'ru' : 'en'; },

    LINES: {
        ru: {
            hi: ['привет всем!', 'всем ку', 'хай)', 'приветик', 'я снова тут', 'всем привет, го проходить', 'здарова', 'хеей', 'приветики',
                'кто тут новенький?', 'опять это обби', 'я вернулся', 'ку ку', 'всем добрый день', 'го вместе', 'привет! кто на каком этапе?',
                'здравствуйте', 'всем хай, я тут первый раз', 'о, народ есть', 'приветствую обби-мастеров'],
            hiReply: ['привет!', 'хай', 'ку', 'приветик)', 'о, привет', 'здарова', 'хеллоу', 'привет, го с нами', 'добро пожаловать', 'хай! догоняй'],
            bye: ['всё, я спать', 'пока всем', 'меня мама зовёт', 'завтра доиграю', 'бб', 'пока!', 'всё, ухожу', 'до завтра, обби', 'уроки делать(',
                'перерыв на обед', 'всем удачи до финиша', 'выхожу, пока'],
            fall: ['опять упал(', 'ну почти...', 'оуу', 'кто так строил', 'не честно!', 'блин', 'ой', 'ааааа', 'лагнуло!', 'это не считается',
                'я споткнулся', 'ну как так', 'ещё раз', 'пффф', 'ну вооот', 'я специально', 'мой пинг!!', 'опять чекпоинт', 'аргх',
                'клавиатура залипла', 'это был тест', 'чуть-чуть не хватило', 'камера подвела', 'НЕЕЕТ', 'ну и ладно', 'с третьей попытки точно'],
            fallLava: ['ааа лава!', 'горячо горячо', 'лава меня не любит', 'кто лаву поставил', 'сгорел(', 'не трогайте красное!', 'ауч, лава',
                'я поджарился', 'пол — это лава. буквально', 'опять в лаву'],
            fallWater: ['буль', 'я утонул', 'в воду упал', 'хоть искупался', 'вода холодная!', 'плюх', 'я рыбка теперь', 'буль-буль', 'мокрый(', 'кто-нибудь, полотенце'],
            fallTrap: ['меня сбил молот!', 'эта вертушка читер', 'этот маятник читер', 'не успел проскочить', 'ой, балка', 'меня смахнуло', 'надо было ждать',
                'вертушка быстрее меня', 'бам!', 'как они так крутятся'],
            checkpoint: ['есть!', 'чекпоинт!', 'изи', 'урааа', 'дальше!', 'го го го', 'фух', 'сохранился', 'наконец-то', 'ееее', 'этап мой',
                'лёгкий был', 'это было сложно', 'я крутой', 'дальше будет сложнее?', 'вперёд!', 'ещё чуть-чуть', 'флаг мой', 'успех', 'прошёл без падений!'],
            playerCheckpoint: ['ты быстрый!', 'гг', 'красава', 'ого как ты', 'подожди меня', 'круто прыгаешь', 'ты профи?', 'обгоняешь нас', 'го вместе дальше', 'как ты так?'],
            talk: ['тут сложно', 'кто со мной?', 'классное обби', 'я почти на финише', 'лол', 'у меня лагает', 'какой у вас скин?', 'обожаю батуты',
                'вертушки бесят', 'а финиш где?', 'сколько всего этапов?', 'го наперегонки', 'я уже третий раз прохожу', 'ненавижу падающие плиты',
                'на льду скользко', 'не толкайтесь', 'я сейчас пройду с первой попытки', 'хаха', 'ахах', 'ну и прыжок', 'я ниндзя!', 'кто тут нуб?',
                'шучу)', 'молоты страшные', 'я побил свой рекорд!', 'музыка классная', 'кто играет с телефона?', 'с мышкой легче', 'обби лучше чем уроки'],
            funny: ['я прыгаю лучше всех', 'смотрите как танцую', 'кто тоже любит обби?', 'мой кот смотрит как я играю', 'щас будет рекорд',
                'я бы построил сложнее', 'спорим я первый?', 'обби = жизнь', 'пора на перерыв... нет', 'я не упал, я исследую лаву'],
            ask: ['у кого какой этап?', 'вы на каком этапе?', 'кто дальше всех?', 'какой этап у вас?', 'сколько у вас этапов?', 'кто где?'],
            answer: ['я на {n}', '{n}', 'у меня {n}', '{n} этап', 'на {n}, а что', 'я только {n}', '{n}, иду дальше', 'уже {n}!', '{n}, застрял', '{n}, догоняйте'],
            help: ['как тут прыгнуть?', 'помогите', 'не получается', 'как пройти вертушку?', 'как пройти молот?', 'что делать с падающими плитами?', 'как не упасть со льда?'],
            helpReply: ['прыгай с самого края', 'разбегись сильнее', 'жди когда вертушка уйдёт', 'жди, пока молот качнётся назад', 'не торопись', 'камеру поверни',
                'прыгай раньше', 'у меня тоже не сразу', 'на падающих не стой, беги', 'на льду тормози заранее', 'держись по центру'],
            win: ['Я ПРОШЁЛ!!!', 'финиш! гг', 'ура победа', 'я сделал это!', 'ГГ ВП', 'изи обби', 'кто следующий на финиш?', 'вершина моя!', 'кубок мой!'],
            knocked: ['эй, аккуратнее!', 'ой, ты чего', 'меня сбили!', 'зачем толкаться', 'ай!', 'я не готов был', 'ладно, я сам виноват', 'бам', 'так не играют', 'отомщу)'],
        },
        en: {
            hi: ['hi everyone!', 'hey', 'yo', 'hello :)', 'back again', 'hi all, lets go', 'sup', 'heyy', 'hiii', 'anyone new here?', 'this obby again',
                'im back', 'hello hello', 'good day all', 'lets go together', 'hi! what stage are you on?', 'greetings', 'first time here, hi', 'oh, people', 'hi obby masters'],
            hiReply: ['hi!', 'hey', 'yo', 'hello)', 'oh hi', 'sup', 'hey there', 'hi, join us', 'welcome', 'hi! catch up'],
            bye: ['ok im off to bed', 'bye all', 'gotta go', 'will finish tomorrow', 'bb', 'bye!', 'leaving now', 'see ya, obby', 'homework time(',
                'lunch break', 'good luck to the finish', 'logging off, bye'],
            fall: ['fell again', 'so close...', 'oof', 'who built this', 'not fair!', 'ugh', 'oops', 'aaaa', 'lag!', 'that doesnt count', 'i tripped',
                'how', 'again', 'pfff', 'nooo', 'i meant to do that', 'my ping!!', 'back to checkpoint', 'argh', 'my keyboard stuck',
                'that was a test', 'so close', 'the camera betrayed me', 'NOOO', 'whatever', 'third try for sure'],
            fallLava: ['nooo lava', 'hot hot hot', 'lava hates me', 'who put lava here', 'burnt(', 'dont touch the red!', 'ouch, lava', 'im toast',
                'the floor is lava. literally', 'lava again'],
            fallWater: ['blub', 'i drowned', 'fell in the water', 'at least i had a swim', 'water is cold!', 'splash', 'im a fish now', 'blub blub', 'so wet(', 'anyone got a towel'],
            fallTrap: ['the hammer got me!', 'that spinner cheats', 'that pendulum cheats', 'too slow', 'oops, the bar', 'got swept away', 'should have waited',
                'the spinner is faster than me', 'bam!', 'how do they spin like that'],
            checkpoint: ['yes!', 'checkpoint!', 'ez', 'yay', 'next!', 'go go go', 'phew', 'saved', 'finally', 'yeee', 'stage done', 'that was easy',
                'that was hard', 'im good', 'does it get harder?', 'onwards!', 'almost there', 'flag is mine', 'success', 'no falls!'],
            playerCheckpoint: ['you are fast!', 'gg', 'nice one', 'whoa', 'wait for me', 'great jumps', 'are you a pro?', 'you are passing us', 'lets go together', 'how do you do that?'],
            talk: ['this is hard', 'anyone with me?', 'nice obby', 'almost at the finish', 'lol', 'lagging a bit', 'whats your skin?', 'love trampolines',
                'spinners are annoying', 'where is the finish?', 'how many stages total?', 'lets race', 'third time beating it', 'i hate falling tiles',
                'ice is slippery', 'stop pushing', 'first try incoming', 'haha', 'lmao', 'what a jump', 'im a ninja!', 'who is a noob here?',
                'jk)', 'hammers are scary', 'i beat my record!', 'great music', 'who plays on phone?', 'mouse is easier', 'obby beats homework'],
            funny: ['i jump better than all', 'watch me dance', 'who else loves obbies?', 'my cat is watching me play', 'record incoming',
                'i would build it harder', 'bet im first?', 'obby is life', 'time for a break... no', 'i didnt fall, im exploring the lava'],
            ask: ['what stage is everyone?', 'which stage are you on?', 'who is furthest?', 'stage check?', 'how far are you?', 'where is everyone?'],
            answer: ['im on {n}', '{n}', 'stage {n}', '{n} lol', '{n}, why', 'only {n}', '{n}, moving on', 'already {n}!', '{n}, stuck', '{n}, catch up'],
            help: ['how do I jump here?', 'help', 'cant do it', 'how to pass the spinner?', 'how to pass the hammer?', 'what to do with falling tiles?', 'how not to slip on ice?'],
            helpReply: ['jump from the very edge', 'run up more', 'wait for the spinner to pass', 'wait till the hammer swings back', 'dont rush', 'turn the camera',
                'jump earlier', 'took me a while too', 'dont stand on falling ones, run', 'brake early on ice', 'stay in the middle'],
            win: ['I BEAT IT!!!', 'finish! gg', 'yay win', 'i did it!', 'GG WP', 'ez obby', 'who is next to finish?', 'top of the tower!', 'the cup is mine!'],
            knocked: ['hey, careful!', 'oh, why', 'i got bumped!', 'why push', 'ouch!', 'i was not ready', 'ok, my bad', 'bam', 'not cool', 'i will get you back)'],
        },
    },

    /** Причина смерти (ObbyCourse.killCause) -> категория реплики. */
    categoryFor(cause) {
        return cause === 'lava' ? 'fallLava' : cause === 'water' ? 'fallWater' : cause === 'trap' ? 'fallTrap' : 'fall';
    },

    /** Категории, которые есть в словаре. */
    categories() { return Object.keys(this.LINES.en); },

    /** Строки категории на языке ('' — нет такой категории). */
    lines(lang, category) {
        const l = this.LINES[this.lang(lang)] || this.LINES.en;
        return l[category] || this.LINES.en[category] || [];
    },

    /** Строка нарушает правила: ссылка, адрес, почта, соцсети, номер телефона или длинное число. */
    unsafe(text) {
        return /https?:|www\.|\.(com|ru|net|org|io|me|gg|app|xyz)\b|@|t\.me|vk\.|discord|youtube|telegram|whatsapp|instagram|\d{5,}/i.test(String(text));
    },

    /** Игра дописывает свои реплики: небезопасные отбрасываются. Возвращает, сколько добавлено. */
    add(lang, category, lines) {
        const code = this.lang(lang);
        const list = this.LINES[code][category] || (this.LINES[code][category] = []);
        let n = 0;
        for (const s of lines || []) if (typeof s === 'string' && s.trim() && !this.unsafe(s) && !list.includes(s)) { list.push(s); n++; }
        return n;
    },

    _last: {},

    /**
     * Случайная строка категории: rng() -> [0, 1) отдаёт вызывающий (бот с зерном — детерминированно). Одну и ту же строку
     * два раза подряд в категории не отдаёт. vars: { n, name } подставляются вместо {n}, {name}. Нет категории — ''.
     */
    pick(lang, category, rng, vars) {
        const list = this.lines(lang, category);
        if (!list.length) return '';
        const r = typeof rng === 'function' ? rng : Math.random;
        const key = this.lang(lang) + '/' + category;
        let i = Math.min(list.length - 1, Math.floor(r() * list.length));
        if (list.length > 1 && this._last[key] === i) i = (i + 1 + Math.floor(r() * (list.length - 1))) % list.length;
        this._last[key] = i;
        const v = vars || {};
        return list[i].replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
    },
};
