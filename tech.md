# Catalogue-Aware Product Recall Agent

**Рабочее название:** RecallOps AI  
**Версия ТЗ:** 1.1  
**Формат:** локальный hackathon MVP  
**Лимит разработки:** 5 часов  
**Статус:** source of truth для реализации

**Changelog:** v1.1 — Claude API заменён на OpenAI API; добавлены последовательные стадии разработки с обязательными stage gates.

## 1. Цель проекта

Создать локально запускаемый сайт-дашборд для небольших импортёров и ритейлеров. Система загружает каталог компании, обрабатывает архивные официальные оповещения об опасных товарах, сопоставляет их с товарами компании, явно показывает неопределённость и ведёт человека через процесс реагирования.

Продукт должен продемонстрировать не чат-бот, а агентный workflow:

1. получить новый алерт;
2. извлечь из него структурированные признаки;
3. найти кандидатов в каталоге;
4. оценить совпадение и объяснить результат;
5. самостоятельно выбрать следующий безопасный шаг;
6. создать кейс, очередь ревью, запрос доказательства или черновики действий;
7. дождаться решения человека перед любым критичным действием;
8. записать каждое событие в неизменяемый аудит-лог.

## 2. Целевая аудитория и позиционирование

Целевая аудитория: маленькие импортёры, дистрибьюторы и ритейлеры без ERP и отдельной compliance-команды.

Ключевое обещание: вместо многонедельной интеграции пользователь загружает CSV/XLSX с каталогом и получает работающий мониторинг за несколько минут.

Главное отличие MVP:

- не широкий охват десятков источников;
- не полностью автономное принятие решений;
- сфокусированная демонстрация качественного matching;
- активная обработка недостающих доказательств;
- видимый human-in-the-loop;
- полный defensible incident record.

## 3. Критерии успеха

MVP оценивается по четырём основным осям:

1. **Matching precision and recall:** релевантные товары находятся, нерелевантные не создают ложные кейсы.
2. **Speed:** после запуска цикла результаты появляются за несколько секунд на демонстрационном наборе.
3. **Uncertainty handling:** система не маскирует сомнения одним числом, а объясняет конфликтующие и отсутствующие сигналы и просит конкретное доказательство.
4. **Response record completeness:** по кейсу видны исходный алерт, кандидаты, решения людей, затронутые товары и клиенты, созданные действия и время каждого события.

## 4. Жёсткие границы MVP

### Обязательно, P0

- локальный запуск через npm и Docker;
- одноразовый онбординг;
- импорт каталога из CSV и XLSX;
- опциональный импорт клиентских покупок;
- настройка порога уверенности;
- загрузка трёх-пяти архивных алертов Safety Gate/RASFF из локальных fixtures;
- локальное сопоставление алертов с каталогом;
- Alert Feed и Dashboard;
- Review Queue с объяснением неопределённости;
- подтверждение, отклонение и запрос доказательства;
- создание и просмотр incident case;
- затронутые SKU, партии, остатки и клиенты;
- черновики действий с ручным одобрением;
- полный аудит-таймлайн;
- экспорт кейса в CSV и PDF;
- надёжный demo seed и работа без OpenAI API key.

### Только если осталось время, P1

- ручная кнопка загрузки свежих алертов из публичного источника;
- drag-and-drop загрузка файлов;
- фильтры и поиск по всем таблицам;
- редактирование текста черновика в модальном окне;
- улучшенная адаптивность для мобильного экрана;
- один Playwright smoke test.

### Не делать

- production deployment;
- регистрацию, логин, роли и multi-tenancy;
- реальную отправку email/SMS;
- реальное подключение к POS, ERP, SAP или 1С;
- cron, message queue, WebSocket/SSE;
- автоматическую подачу документов регулятору;
- самостоятельное удаление или блокировку товара во внешней системе;
- полноценный web scraper нескольких источников;
- сложную модель прав доступа;
- микросервисную архитектуру;
- Kubernetes, Caddy, Terraform, CI/CD и production observability.

## 5. Источники данных

### Официальные алерты

- [EU Safety Gate](https://ec.europa.eu/safety-gate-alerts/) — опасные непродовольственные товары.
- [RASFF Window](https://webgate.ec.europa.eu/rasff-window/screen/search) — пищевые продукты и корма.

Для P0 использовать архивные записи, сохранённые в `data/alerts/*.json`. Каждая запись обязана сохранять `source`, `sourceReference`, `sourceUrl` и `publishedAt`.

Кнопка **Run monitoring** вызывает локальный `ArchiveAlertSource`, который возвращает ещё не импортированные fixtures. Это имитирует новый цикл мониторинга без хрупкой live-интеграции.

### Каталог и клиентская база

Данные загружает пользователь. Они сохраняются в локальной SQLite.

Минимальные колонки каталога:

| Поле | Обязательное | Пример |
| --- | --- | --- |
| `sku` | да | `TOY-1042` |
| `name` | да | `Kids magnetic building set` |
| `brand` | да | `BuildJoy` |
| `ean` | нет | `5391234567890` |
| `batch` | нет | `BJ-24-08A` |
| `supplier_name` | нет | `Northstar Imports` |
| `supplier_email` | нет | `recalls@example.test` |
| `category` | нет | `Toys` |
| `stock_quantity` | нет | `17` |

Минимальные колонки клиентской базы:

| Поле | Обязательное | Пример |
| --- | --- | --- |
| `customer_id` | да | `C-1007` |
| `customer_name` | нет | `Demo Customer` |
| `email` | нет | `customer@example.test` |
| `sku` | да | `TOY-1042` |
| `batch` | нет | `BJ-24-08A` |
| `purchased_at` | да | `2026-08-10` |

### OpenAI API

GPT не является источником фактов и не принимает финальные решения. OpenAI API используется только для:

- извлечения структурированных полей из неструктурированного текста алерта;
- превращения рассчитанных сигналов в краткое объяснение;
- подготовки черновика письма поставщику;
- подготовки черновика уведомления клиентам.

Весь числовой scoring рассчитывается локальным кодом. Ответ модели получается через Responses API и валидируется Zod-схемой. При отсутствии ключа или ошибке API используются детерминированный parser и шаблонные тексты.

Использовать официальный server-side API key из `OPENAI_API_KEY`. ChatGPT Plus и OpenAI API имеют раздельный доступ и биллинг: подписка Plus не предоставляет API credits. Допускается тот же OpenAI-аккаунт, но ключ создаётся отдельно в OpenAI Platform. Никогда не использовать cookies, session tokens или другие данные авторизации ChatGPT как API key.

## 6. Технологический стек

- SvelteKit, TypeScript;
- Tailwind CSS;
- SQLite;
- Drizzle ORM и `better-sqlite3`;
- локальный fuzzy matching через `fuzzball` за интерфейсом `FuzzyMatcher`;
- `csv-parse` для CSV;
- `read-excel-file` для XLSX;
- Zod для валидации;
- официальный OpenAI SDK и Responses API;
- `pdf-lib` для PDF;
- Vitest для критичной доменной логики;
- Docker и Docker Compose только для локального запуска;
- npm и lockfile для воспроизводимых зависимостей.

Не добавлять отдельный Python-сервис только ради RapidFuzz. Официальный RapidFuzz ориентирован на Python/C++; для 5-часового SvelteKit MVP использовать локальный JavaScript matcher с аналогичными `ratio`/`token_set_ratio`-метриками. Возможность заменить реализацию сохраняется через интерфейс.

## 7. Архитектура

Использовать простой SvelteKit monolith:

```text
src/
  lib/
    components/          # общие UI-компоненты
    types/               # общие TypeScript-типы
    server/
      db/                # Drizzle schema, connection, seed
      alerts/            # источники и нормализация алертов
      matching/          # scoring и объяснение сигналов
      workflow/          # переходы состояний и создание задач
      imports/           # CSV/XLSX parsing и validation
      llm/               # OpenAI adapter и deterministic fallback
      exports/           # CSV/PDF отчёты
  routes/
    onboarding/
    dashboard/
    alerts/[id]/
    review/
    cases/[id]/
    actions/
    api/monitor/
    api/cases/[id]/export.csv/
    api/cases/[id]/export.pdf/
data/
  alerts/                # архивные официальные fixtures
  demo/                  # synthetic catalog and customers
drizzle/
static/
```

Правила архитектуры:

- routes отвечают за HTTP/UI, доменная логика находится в `lib/server`;
- зависимости направлены от workflow к интерфейсам источника, LLM и matcher;
- все изменения кейса и аудит-события выполняются в одной DB transaction;
- никакой логики scoring внутри Svelte-компонентов;
- внешние данные считаются недоверенными;
- LLM никогда не получает возможность напрямую менять БД или отправлять сообщение.

### Общие контракты

Эти названия считаются замороженными для MVP:

```ts
type AlertSourceName = 'safety_gate' | 'rasff';
type AlertStatus = 'matched' | 'needs_review' | 'not_relevant';
type MatchStatus = 'candidate' | 'confirmed' | 'rejected' | 'awaiting_evidence';
type CaseStatus = 'open' | 'contained' | 'closed';
type ActionType = 'block_sale' | 'notify_supplier' | 'notify_customers';
type ActionStatus = 'draft' | 'approved' | 'simulated_sent' | 'not_available';

interface NormalizedAlert {
  source: AlertSourceName;
  sourceReference: string;
  sourceUrl: string;
  title: string;
  description: string;
  risk: string;
  productName: string;
  brand?: string;
  ean?: string;
  batch?: string;
  category?: string;
  publishedAt: string;
}

interface ScoreBreakdown {
  total: number;
  ean: number;
  name: number;
  brand: number;
  batch: number;
  hasHardConflict: boolean;
  reasons: string[];
  requestedEvidence: string[];
}

interface AlertSource {
  getNewAlerts(existingReferences: Set<string>): Promise<NormalizedAlert[]>;
}

interface FuzzyMatcher {
  ratio(left: string, right: string): number;
  tokenSetRatio(left: string, right: string): number;
}

interface LlmClient {
  extractAlert(input: string): Promise<NormalizedAlert>;
  explainMatch(input: ScoreBreakdown): Promise<string>;
  draftAction(type: ActionType, context: Record<string, unknown>): Promise<string>;
}

interface ReportExporter {
  exportCase(caseId: string, format: 'csv' | 'pdf'): Promise<Uint8Array>;
}
```

## 8. Модель данных

SQLite хранит время в ISO 8601 UTC string. Идентификаторы — `text` UUID. Enum-подобные значения — `text` с TypeScript union и runtime validation.

| Таблица | Основные поля |
| --- | --- |
| `settings` | `id`, `confidenceThreshold`, `reviewFloor`, `onboardingCompleted`, `createdAt`, `updatedAt` |
| `products` | `id`, `sku`, `name`, `normalizedName`, `brand`, `normalizedBrand`, `ean`, `batch`, `supplierName`, `supplierEmail`, `category`, `stockQuantity`, `createdAt` |
| `customers` | `id`, `externalId`, `name`, `email`, `createdAt` |
| `purchases` | `id`, `customerId`, `productId`, `batch`, `purchasedAt`, `quantity` |
| `alerts` | `id`, `source`, `sourceReference`, `sourceUrl`, `title`, `description`, `risk`, `imageUrl`, `brand`, `productName`, `ean`, `batch`, `category`, `publishedAt`, `status`, `rawJson`, `createdAt` |
| `matches` | `id`, `alertId`, `productId`, `totalScore`, `nameScore`, `brandScore`, `eanScore`, `batchScore`, `hasHardConflict`, `explanation`, `status`, `createdAt`, `decidedAt` |
| `cases` | `id`, `caseNumber`, `alertId`, `status`, `severity`, `openedAt`, `closedAt` |
| `caseItems` | `id`, `caseId`, `productId`, `batch`, `stockQuantity` |
| `caseTasks` | `id`, `caseId`, `type`, `label`, `status`, `completedBy`, `completedAt` |
| `evidenceRequests` | `id`, `matchId`, `requestedEvidence`, `recipient`, `status`, `createdAt`, `resolvedAt` |
| `actionDrafts` | `id`, `caseId`, `type`, `recipient`, `subject`, `body`, `status`, `approvedBy`, `approvedAt`, `createdAt` |
| `auditEvents` | `id`, `caseId`, `alertId`, `eventType`, `actorType`, `actorName`, `summary`, `metadataJson`, `createdAt` |

Обязательные ограничения и индексы:

- unique: `products.sku`;
- unique: `customers.externalId`;
- unique: `(alerts.source, alerts.sourceReference)`;
- unique: `cases.alertId`;
- indexes: `products.ean`, `products.normalizedBrand`, `matches.alertId`, `cases.status`, `auditEvents.caseId`;
- unique: `(caseItems.caseId, caseItems.productId, caseItems.batch)` и `(caseTasks.caseId, caseTasks.type)`;
- `actionDrafts.status`: `draft | approved | simulated_sent | not_available`;
- `caseTasks.status`: `pending | completed | not_available`;
- `cases.status`: `open | contained | closed`;
- `alerts.status`: `matched | needs_review | not_relevant`;
- `matches.status`: `candidate | confirmed | rejected | awaiting_evidence`.

## 9. Matching и confidence scoring

### Нормализация

Перед сравнением:

- привести текст к lowercase;
- удалить лишнюю пунктуацию и повторные пробелы;
- нормализовать дефисы и пробелы в batch number;
- удалить пробелы из EAN;
- не изменять исходные значения в БД;
- EAN сравнивать только как идентификатор, а не как обычный fuzzy text.

### Четыре сигнала

| Сигнал | Вес | Правило |
| --- | ---: | --- |
| EAN | 45% | `1` только при точном совпадении; известное несовпадение создаёт hard conflict |
| Product name/model | 25% | `token_set_ratio / 100` |
| Brand | 20% | exact или fuzzy ratio |
| Batch | 10% | exact или fuzzy ratio; отсутствие даёт `0` и missing-evidence reason |

Формула:

```text
totalScore = round(45*ean + 25*name + 20*brand + 10*batch)
```

Не перенормировать веса, если поле отсутствует. Отсутствие идентификатора должно снижать уверенность, а не искусственно повышать её.

### Классификация

- `score >= confidenceThreshold` и нет hard conflict: пометить кандидата как high-confidence recommendation и отправить на обязательное human confirmation;
- `reviewFloor <= score < confidenceThreshold`: добавить в Review Queue;
- hard conflict при достаточно близких brand/name: всегда Review Queue;
- `score < reviewFloor` и нет сильного идентификатора: `not_relevant`;
- значения по умолчанию: `confidenceThreshold = 85`, `reviewFloor = 55`.

Пользователь меняет верхний порог в онбординге в диапазоне 70–95%. Нижний порог остаётся 55% в MVP.

### Объяснение неопределённости

Система показывает не только итоговый score, но и:

- какие поля совпали;
- какие поля отсутствуют;
- какие поля конфликтуют;
- какое доказательство устранит неопределённость.

Пример:

> Brand and product name are strong matches, but the EAN is different. Request a barcode photo or supplier invoice before confirming this product.

Объяснение сначала строится из детерминированных причин. GPT может улучшить формулировку, но не менять score, статус или факты.

## 10. Agent workflow

Функция `runMonitoringCycle()` выполняет один идемпотентный цикл:

1. получить новые алерты из `AlertSource`;
2. пропустить уже существующие `(source, sourceReference)`;
3. извлечь и валидировать поля;
4. найти top-3 кандидатов в каталоге;
5. рассчитать четыре сигнала;
6. сохранить match и объяснение;
7. выбрать следующий шаг по правилам классификации;
8. создать case либо review item;
9. записать audit event;
10. вернуть summary для обновления Dashboard.

Human-in-the-loop переходы:

- **Confirm match:** `match → confirmed`, создать или переиспользовать case для алерта, затем добавить case item, checklist и drafts;
- **Reject:** `match → rejected`, алерт становится `not_relevant`, записать решение;
- **Request evidence:** `match → awaiting_evidence`, создать evidence request и supplier draft, ничего не отправлять;
- **Approve & send:** сохранить имя человека и время, затем только имитировать отправку со статусом `simulated_sent`;
- **Close case:** разрешить только после явного подтверждения обязательных checklist items, closure note и ссылки/номера доказательства.

Повторный вызов одной мутации не должен создавать второй кейс, второй draft или дублирующий эффект.

## 11. Интерфейс

Язык интерфейса — английский. Основной viewport — desktop/laptop. Общая оболочка: sidebar navigation, page title, compact top-right demo user.

Навигация: **Overview**, **Review Queue**, **Cases**, **Action Drafts**. Использовать светлый нейтральный фон, белые cards, красный для риска, amber для неопределённости, green для подтверждённого совпадения и slate для нерелевантных записей.

Минимальные общие компоненты: `Button`, `Badge`, `Card`, `DataTable`, `FileUpload`, `EmptyState`, `ConfirmDialog`, `Timeline`, `ScoreBreakdown`, `DraftLabel`. Не подключать тяжёлую UI-библиотеку ради этих компонентов.

### 11.1 Onboarding

Показывается один раз, если `onboardingCompleted = false`.

- блок **Upload product catalogue**;
- блок **Upload customer purchases (optional)**;
- preview первых пяти валидных строк;
- количество принятых и отклонённых строк;
- слайдер **Confidence threshold**, default 85%;
- кнопка **Complete setup & run monitoring**;
- ссылка **Use demo data** для гарантированного сценария.

После завершения пользователь попадает на Dashboard.

### 11.2 Dashboard / Alert Feed

Верхние карточки:

- New alerts today;
- Waiting for review;
- Open cases;
- Closed this month.

Ниже таблица Alert Feed:

- alert product name;
- source badge: Safety Gate/RASFF;
- risk;
- published date;
- best catalogue match preview;
- confidence;
- status badge: `Confirmed match`, `Needs review`, `Not relevant`.

Клик открывает `/alerts/[id]`.

### 11.3 Review Queue

Главный экран демо. Показывать по одному review item с переключением между элементами.

Левая колонка, **Official alert**:

- фото;
- source и reference;
- product name, brand, EAN, batch;
- risk description;
- ссылка на оригинал.

Правая колонка, **Catalogue candidate**:

- SKU, name, brand, EAN, batch;
- supplier;
- stock quantity;
- affected purchase count, если доступно.

Между/под колонками:

- общий confidence score;
- breakdown четырёх сигналов;
- блок **Why the agent is uncertain**;
- список missing/conflicting evidence;
- кнопки **Confirm match**, **Reject**, **Request evidence**.

`Request evidence` открывает форму с checkbox: barcode photo, supplier invoice, batch label photo; получатель берётся из каталога, текст сохраняется как draft.

### 11.4 Incident case

- case number, status, severity, source reference;
- вертикальный audit timeline;
- affected SKU/batches и stock quantity;
- affected customers;
- checklist: Block sale, Notify supplier, Notify customers;
- связанные action drafts;
- кнопки экспорта CSV/PDF.

### 11.5 Action Drafts

Каждая карточка содержит:

- яркий label **DRAFT — NOT SENT**;
- type, recipient, subject, body;
- **Edit**;
- **Approve & send**;
- после подтверждения: `Approved by`, `Approved at`, статус **SIMULATED SEND**.

Перед одобрением показать confirm dialog. В нём явно написать, что MVP имитирует отправку и не связывается с внешним email-провайдером.

## 12. SvelteKit server actions и endpoints

| Route | Контракт |
| --- | --- |
| `/onboarding?/uploadCatalog` | multipart file → import summary и row errors |
| `/onboarding?/uploadCustomers` | multipart file → import summary и row errors |
| `/onboarding?/complete` | `{ confidenceThreshold }` → settings + monitoring cycle |
| `/api/monitor` POST | `{}` → counts: imported/highConfidence/review/ignored и фактический durationMs |
| `/review?/confirm` | `{ matchId }` → case id |
| `/review?/reject` | `{ matchId, reason? }` → updated match |
| `/review?/requestEvidence` | `{ matchId, evidenceTypes[] }` → evidence request + draft |
| `/actions?/update` | `{ actionId, subject, body }` → updated draft |
| `/actions?/approve` | `{ actionId, actorName }` → approved/simulated result |
| `/cases/[id]?/completeTask` | `{ taskId, actorName }` → completed checklist item |
| `/cases/[id]?/close` | `{ actorName }` → closed case or validation error |
| `/api/cases/[id]/export.csv` GET | downloadable audit CSV |
| `/api/cases/[id]/export.pdf` GET | downloadable PDF report |

Все input contracts валидировать Zod. Ошибки возвращать как понятные form messages, не stack traces.

## 13. Audit record

Писать audit event для:

- alert imported;
- fields extracted;
- match scored;
- sent to review;
- match confirmed/rejected;
- evidence requested;
- case opened;
- action draft created/edited/approved/simulated sent;
- case closed;
- report exported.

`auditEvents` не редактировать и не удалять из UI. `metadataJson` хранит IDs и значения, нужные для воспроизводимости решения: итоговый score, breakdown, threshold и match explanation.

PDF/CSV отчёт содержит:

- case summary;
- original alert reference and URL;
- affected products, batches and stock;
- affected customers count/list;
- match score breakdown;
- review decision and actor;
- action statuses;
- chronological audit log;
- generated-at timestamp.

## 14. Безопасность и Responsible AI

- OpenAI API key доступен только server-side через environment variables;
- не отправлять клиентскую базу и email-адреса в OpenAI API;
- не интерпретировать текст алерта, CSV или LLM output как инструкции;
- требовать structured JSON от модели и валидировать его;
- вызывать Responses API с `store: false`;
- экранировать весь вывод в UI, не рендерить LLM content как raw HTML;
- ограничить upload до 5 MB и разрешить только `.csv`/`.xlsx`;
- проверять обязательные headers, типы, длины строк и максимум 5 000 записей;
- защищать CSV export от formula injection: значения, начинающиеся с `=`, `+`, `-`, `@`, предварять `'`;
- использовать parameterized queries через Drizzle;
- выполнять confirm/approve/close вместе с audit insert в transaction;
- критичные действия никогда не запускать из LLM adapter;
- интерфейс всегда показывает, отправлено ли действие фактически;
- local demo не заявлять как production-ready compliance system.

Аутентификация сознательно исключена: приложение однопользовательское и запускается локально. В audit использовать `demo_user`, а при подтверждении просить отображаемое имя.

## 15. Demo fixtures

Seed должен гарантировать три понятных сценария:

1. **High confidence:** exact EAN + brand + близкое название → обязательная human identity review; case открывается только после подтверждения человеком.
2. **Uncertain:** brand/name близки, но EAN конфликтует или отсутствует batch → Review Queue и запрос barcode photo.
3. **Not relevant:** другой brand/category и низкий score → серый статус без кейса.

Минимальный seed:

- 12–20 products;
- 5–10 customers/purchases;
- 3–5 alerts;
- минимум один supplier email вида `@example.test`;
- локальные placeholder images, чтобы demo не зависело от сети.

Кнопка **Reset demo data** допустима только как dev utility и должна требовать подтверждение.

## 16. Обработка ошибок

- невалидный upload: сохранить валидные строки только после подтверждения summary либо отклонить весь файл; для MVP выбрать атомарное отклонение файла;
- duplicate SKU: показать номера строк и не импортировать файл;
- duplicate alert: безопасно пропустить;
- OpenAI timeout/error: использовать fallback и добавить нейтральное audit metadata, не ломать workflow;
- нет customer data: создать case и supplier draft, customer action пометить `not_available`;
- нет supplier email: создать draft без recipient и показать `Recipient required`;
- export error: показать retry message, не менять case;
- повторный approve: вернуть существующий результат без второго side effect.

## 17. Минимальный набор тестов

Не строить большую test suite. Написать Vitest-тесты только на критичную логику:

1. exact identifiers дают high-confidence result;
2. EAN conflict создаёт hard conflict и Review Queue;
3. missing fields не перенормируют score;
4. threshold boundaries 54/55/84/85 классифицируются правильно;
5. повторный monitoring cycle не дублирует alerts/matches, а до human confirmation не создаёт case;
6. confirm создаёт case и audit event в одной операции;
7. action остаётся draft до ручного approve;
8. повторный approve не создаёт второй эффект;
9. CSV export нейтрализует formula injection.

Перед завершением выполнить:

```bash
npm run check
npm run test
npm run build
```

## 18. Критерии приёмки MVP

- чистый локальный запуск описан в README;
- **Use demo data** поднимает полностью заполненный сценарий;
- Dashboard показывает три разных статуса алертов;
- uncertain match объясняет минимум один positive и один conflicting/missing signal;
- `Request evidence` создаёт конкретный запрос и audit event;
- `Confirm match` открывает case с item, checklist и drafts;
- ни один draft не меняет статус без ручного approve;
- UI явно различает `DRAFT — NOT SENT` и `SIMULATED SEND`;
- case timeline показывает действия агента и человека с timestamp;
- CSV и PDF скачиваются и содержат полный case record;
- приложение работает без API key через fallback;
- check, critical tests и build проходят;
- проект находится на GitHub и не требует внешнего deployment.

## 19. Последовательные стадии разработки

Разрабатывать проект только по стадиям ниже. Одна AI coding session получает одну стадию. Запрещено реализовывать будущие стадии заранее.

### 19.1 Общий stage-gate prompt

Перед каждой стадией передать нейросети `catalogue-recall-agent-tech.md` и следующий prompt, заменив `N` номером стадии:

```text
Read catalogue-recall-agent-tech.md completely and implement only Stage N.

Before changing code:
1. Inspect the current repository and git status.
2. Verify that the previous stage satisfies its exit gate.
3. If the previous stage is incomplete, fix and re-verify it first. Do not start Stage N.

During implementation:
- Stay inside the Stage N scope.
- Do not implement later stages or add speculative abstractions.
- Preserve the frozen contracts and database status values from tech.md.
- Keep the app runnable after every meaningful change.

Before finishing:
1. Run every automated check required by this stage.
2. Perform the listed manual verification.
3. Fix failures and repeat the checks.
4. Commit only after all required checks pass.

End with exactly this report:
STAGE N REPORT
Status: PASS | BLOCKED
Changed files: ...
Acceptance checks: ...
Commands run: ...
Manual verification: ...
Known limitations: ...
Commit: ...

Do not start or propose implementation of Stage N+1. A PASS report is required before the next stage.
```

Если отчёт имеет `Status: BLOCKED`, следующей сессии снова передать ту же стадию вместе с ошибками. Переходить дальше можно только после `PASS`.

### Stage 0 — Foundation, 25 минут

**Цель:** создать минимальный запускаемый skeleton.

Реализовать:

- SvelteKit + TypeScript + Tailwind;
- npm scripts: `dev`, `check`, `test`, `build`, `db:migrate`, `db:seed`;
- SQLite/Drizzle connection и пустую initial migration;
- структуру папок из раздела 7;
- app shell с навигацией Overview, Review Queue, Cases, Action Drafts;
- `.env.example`, `.gitignore`, базовый README;
- placeholder pages без бизнес-логики.

**Exit gate:**

- `npm run check` проходит;
- `npm run test` запускается без configuration error;
- `npm run build` проходит;
- `npm run db:migrate` создаёт локальную БД;
- `/dashboard` открывается, sidebar links не дают 404;
- в репозитории нет API keys, database file и `node_modules`.

### Stage 1 — Database and demo fixtures, 30 минут

**Цель:** зафиксировать данные и воспроизводимый demo state.

Реализовать:

- Drizzle schema, constraints и indexes из раздела 8;
- миграцию для всех P0-таблиц;
- repository helpers только для реально используемых запросов;
- 12–20 products, 5–10 purchases и 3–5 alerts;
- три сценария: high confidence, uncertain, not relevant;
- идемпотентный `db:seed` и dev-only reset utility.

**Exit gate:**

- миграция проходит на новой пустой БД;
- два последовательных `npm run db:seed` не создают duplicates;
- SQLite содержит все три demo scenarios;
- unique constraints отклоняют duplicate SKU и duplicate source reference;
- `npm run check` и `npm run test` проходят.

### Stage 2 — Onboarding and imports, 35 минут

**Цель:** пользователь может начать без ручной работы с БД.

Реализовать:

- onboarding page;
- CSV/XLSX import каталога;
- опциональный import customer purchases;
- Zod validation, 5 MB/5 000 row limits и атомарное отклонение bad file;
- preview первых пяти строк и понятные row errors;
- confidence slider 70–95, default 85;
- **Use demo data** и **Complete setup & run monitoring**.

**Exit gate:**

- валидный CSV и XLSX импортируются;
- неправильные headers и duplicate SKU показывают понятную ошибку;
- невалидный файл не оставляет partial rows;
- выбранный threshold сохраняется;
- **Use demo data** переводит пользователя на Dashboard;
- `npm run check`, импорт-тесты и `npm run build` проходят.

### Stage 3 — Alert ingestion and matching, 60 минут

**Цель:** получить основную агентную классификацию.

Реализовать:

- `ArchiveAlertSource`;
- alert normalization;
- локальный `FuzzyMatcher`;
- формулу четырёх сигналов и hard-conflict rules;
- top-3 candidates;
- идемпотентный `runMonitoringCycle()`;
- high-confidence recommendation с обязательным human confirmation до создания case;
- Review Queue status для uncertain match;
- `not_relevant` для low score;
- Dashboard counters и Alert Feed.

**Exit gate:**

- тесты scoring покрывают exact match, EAN conflict, missing fields и boundaries 54/55/84/85;
- повторный monitoring cycle не дублирует alerts, matches или cases;
- Dashboard одновременно показывает три разных статуса;
- клик по alert открывает детали и best match;
- этап работает без OpenAI API key;
- `npm run check`, `npm run test` и `npm run build` проходят.

### Stage 4 — Review Queue and uncertainty, 45 минут

**Цель:** реализовать центральный экран демо и human decision point.

Реализовать:

- двухколоночную карточку official alert/catalogue candidate;
- score breakdown и deterministic uncertainty reasons;
- **Confirm match**, **Reject**, **Request evidence**;
- evidence form: barcode photo, supplier invoice, batch label photo;
- transactions для решения и audit event;
- idempotent mutations.

**Exit gate:**

- uncertain fixture попадает в Review Queue;
- UI показывает минимум один positive и один conflicting/missing signal;
- confirm создаёт или переиспользует case и добавляет case item;
- reject не создаёт case;
- request evidence создаёт request и unsent supplier draft;
- повторное нажатие не создаёт duplicates;
- тесты всех трёх решений, `check` и `build` проходят.

### Stage 5 — Incident case and manual actions, 40 минут

**Цель:** показать containment workflow и defensible record.

Реализовать:

- case header и status;
- affected SKU, batch, stock и customers;
- checklist: Block sale, Notify supplier, Notify customers;
- append-only audit timeline;
- supplier/customer/block-sale drafts;
- label **DRAFT — NOT SENT**;
- edit, confirm dialog и **Approve & send** simulation;
- actor name и timestamp;
- запрет закрытия незавершённого case.

**Exit gate:**

- новый case содержит items, tasks и drafts;
- до approve не происходит никакого send effect;
- approve записывает actor/time и `SIMULATED SEND`;
- повторный approve идемпотентен;
- timeline различает agent и human events;
- incomplete case не закрывается;
- critical action tests, `check` и `build` проходят.

### Stage 6 — OpenAI adapter and reports, 35 минут

**Цель:** добавить LLM-часть без зависимости demo от API.

Реализовать:

- официальный OpenAI SDK;
- `OpenAiLlmClient` через Responses API;
- structured outputs + Zod validation;
- `store: false`, server-only key и timeout;
- `FallbackLlmClient` с тем же интерфейсом;
- extraction/explanation/draft generation без изменения local score;
- CSV export с formula-injection protection;
- PDF case report.

**Exit gate:**

- при пустом `OPENAI_API_KEY` полный workflow использует fallback;
- при mock API error workflow продолжает работать;
- API key отсутствует в client bundle и logs;
- модель не получает customer emails или полную клиентскую базу;
- malformed model output отклоняется Zod и включает fallback;
- CSV/PDF содержат case summary, decisions, actions и audit timeline;
- export и LLM fallback tests, `check` и `build` проходят.

### Stage 7 — Final verification, 30 минут

**Цель:** зафиксировать стабильный трёхминутный demo.

Новые features запрещены. Выполнить:

- UI cleanup только для demo path;
- empty/loading/error states;
- README с npm и Docker commands;
- Docker build;
- reset + seed на чистой БД;
- полный walkthrough трёх сценариев;
- проверку отсутствия secrets и случайных generated files;
- финальные коммиты и push в GitHub.

**Final gate:**

```bash
npm run db:migrate
npm run db:seed
npm run check
npm run test
npm run build
docker compose up --build
```

Вручную пройти:

```text
onboarding → monitoring → Dashboard → uncertain review → request evidence
→ confirm → case → approve simulation → timeline → CSV/PDF export
```

После reset сценарий должен повторяться без ручного изменения SQLite. Если возникает нехватка времени, сокращать только P1 и декоративные детали. Не сокращать Review Queue, human approval, audit timeline, fallback и три demo scenario.

## 20. Локальный запуск

README должен содержать только необходимое:

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Docker:

```bash
docker compose up --build
```

`.env.example`:

```dotenv
DATABASE_URL=./data/recallops.db
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6
```

Отсутствие `OPENAI_API_KEY` включает fallback автоматически. Значение `OPENAI_MODEL` должно быть конфигурируемым и не дублироваться в коде.

## 21. Правила кода и Git

- следовать DRY там, где повтор уже существует; не создавать абстракции «на будущее»;
- использовать небольшие функции и явные TypeScript-типы;
- применять интерфейсы на границах `AlertSource`, `FuzzyMatcher`, `LlmClient`, `ReportExporter`;
- OOP использовать для адаптеров с состоянием/зависимостями; чистую scoring-логику писать функциями;
- не использовать `any`, кроме изолированной границы внешней библиотеки с немедленной валидацией;
- комментарии писать только на английском, кратко, объяснять почему, а не пересказывать код;
- UI copy, commit messages и PR text писать на английском;
- формат коммита: `type(scope): summary`;
- допустимые types: `feat`, `fix`, `test`, `refactor`, `chore`, `docs`;
- summary — imperative, lowercase, без точки, до 50 символов;
- делать небольшие логические коммиты, но не тратить время на искусственное дробление;
- не добавлять `Co-authored-by`, AI-generated labels, названия моделей или другие упоминания нейросети;
- Git author:

```bash
git config user.name "heeavens"
git config user.email "savchenkohman@gmail.com"
```

## 22. Definition of Done

MVP готов, когда новый человек может клонировать репозиторий, выполнить команды из README, нажать **Use demo data** и за 3–4 минуты показать жюри полный путь:

```text
archived alert → matching → uncertainty review → evidence request or confirmation
→ incident case → manual action approval → audit timeline → PDF/CSV export
```

Демо не должно зависеть от внешней сети, действующего OpenAI API key или ручного редактирования SQLite.
