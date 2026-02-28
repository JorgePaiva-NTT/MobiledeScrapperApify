import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const targetUrl = typeof input.url === 'string' ? input.url.trim() : '';
const proxyCountry = typeof input.proxyCountry === 'string' ? input.proxyCountry.trim().toUpperCase() : '';
const proxyGroup = typeof input.proxyGroup === 'string' ? input.proxyGroup.trim().toUpperCase() : 'RESIDENTIAL';
const maxRequestRetries = Number.isInteger(input.maxRequestRetries) ? input.maxRequestRetries : 4;

if (!targetUrl) {
    throw new Error('Input "url" is required.');
}

if (!/^https?:\/\/suchen\.mobile\.de\//i.test(targetUrl)) {
    throw new Error('Input "url" must be a valid suchen.mobile.de vehicle listing URL.');
}

// Proxy configuration to rotate IP addresses and prevent blocking (https://docs.apify.com/platform/proxy)
let proxyConfiguration;
const preferredGroups = proxyGroup === 'DATACENTER' ? ['DATACENTER'] : ['RESIDENTIAL', 'DATACENTER'];

for (const group of preferredGroups) {
    try {
        proxyConfiguration = await Actor.createProxyConfiguration({
            groups: [group],
            countryCode: proxyCountry || undefined,
        });
        console.info(`Using Apify Proxy group: ${group}${proxyCountry ? ` (country: ${proxyCountry})` : ''}`);
        break;
    } catch (error) {
        console.info(`Proxy group ${group} unavailable${proxyCountry ? ` for country ${proxyCountry}` : ''}, trying fallback.`);
    }
}

if (!proxyConfiguration) {
    try {
        proxyConfiguration = await Actor.createProxyConfiguration({
            countryCode: proxyCountry || undefined,
        });
        console.info('Using default Apify Proxy pool after group fallbacks.');
    } catch (error) {
        if (proxyCountry) {
            console.info(`Proxy country ${proxyCountry} unavailable in default pool, retrying without country.`);
            proxyConfiguration = await Actor.createProxyConfiguration();
        } else {
            throw error;
        }
    }
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: 1,
    maxRequestRetries,
    ignoreHttpErrorStatusCodes: [403],
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 30, blockedStatusCodes: [] },
    persistCookiesPerSession: true,
    preNavigationHooks: [
        async ({ request }, gotOptions) => {
            const lang = 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
            gotOptions.headers = {
                ...(gotOptions.headers ?? {}),
                'accept-language': lang,
                'cache-control': 'no-cache',
                pragma: 'no-cache',
                referer: 'https://www.mobile.de/',
                'upgrade-insecure-requests': '1',
                'user-agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            };
            request.noRetry = false;
        },
    ],
    async requestHandler({ request, response, $, body, log }) {
        const loadedUrl = request.loadedUrl ?? request.url;
        const html = typeof body === 'string' ? body : $.html();

        if (response?.statusCode === 403) {
            throw new Error('Mobile.de returned HTTP 403 (blocked). Run with a working proxy/session to access listing data.');
        }

        if (isAccessDenied(html)) {
            throw new Error('Mobile.de blocked the request (access denied). Try running with a valid proxy/session.');
        }

        const adId = extractIdFromUrl(loadedUrl);
        const jsonObjects = extractEmbeddedJsonObjects($, html);
        const best = findBestAdCandidate(jsonObjects, adId);
        const ld = pickVehicleLd(jsonObjects);
        const attributes = extractAttributesFromDom($);
        const description = cleanText(
            $('.g-row.description p').text()
            || $('[data-testid="description-section"] p').text()
            || $('[class*="description"] p').text(),
        );

        const title =
            cleanText(
                $('h1').first().text()
                || fromPaths(best, [['title'], ['headline'], ['name']])
                || fromPaths(ld, [['name']]),
            ) || null;

        const [shortTitle, subTitle] = splitTitle(title);

        const amountRaw =
            fromPaths(best, [['price', 'amount'], ['price', 'value'], ['priceAmount'], ['amount']])
            ?? fromPaths(ld, [['offers', 'price']]);
        const priceAmount = parseNumber(amountRaw);
        const currency =
            fromPaths(best, [['price', 'currency'], ['currency']])
            || fromPaths(ld, [['offers', 'priceCurrency']])
            || 'EUR';

        const images = extractImages(best, ld, $);
        const features = extractFeatures(best, $);

        const price = {
            priceType: 'FIXED',
            amount: priceAmount,
            currency,
            formatted: formatPrice(priceAmount, currency),
            vat: parseNumber(fromPaths(best, [['price', 'vat'], ['vat']])),
        };

        const netAmount = parseNumber(fromPaths(best, [['netPrice', 'amount'], ['price', 'netAmount']]));
        const netPrice = netAmount
            ? {
                amount: netAmount,
                currency,
                formatted: formatPrice(netAmount, currency),
            }
            : null;

        const output = {
            id: adId,
            url: loadedUrl,
            shortTitle,
            subTitle,
            title,
            properties: mapProperties(attributes),
            descriptionHtml:
                fromPaths(best, [['descriptionHtml'], ['description', 'html']])
                || ($('[data-testid="description-section"]').html() ?? '')
                || '',
            description: description || fromPaths(best, [['description'], ['descriptionText']]) || null,
            isNew: guessIsNew(attributes, best),
            isDamaged: guessIsDamaged(attributes, best),
            isReadyToDrive: true,
            isConditionNew: guessIsNew(attributes, best),
            segment: fromPaths(best, [['segment'], ['vehicleType']]) || 'Car',
            category: fromPaths(best, [['category'], ['bodyType']]) || attributes.Category || null,
            sellerId: parseNumber(fromPaths(best, [['sellerId'], ['seller', 'id'], ['vendor', 'id']])),
            manufacturer: fromPaths(best, [['manufacturer'], ['brand'], ['make']]) || null,
            model: fromPaths(best, [['model']]) || null,
            price,
            netPrice,
            createdTime: normalizeDate(fromPaths(best, [['createdTime'], ['createdAt'], ['created']])),
            modifiedTime: normalizeDate(fromPaths(best, [['modifiedTime'], ['updatedAt'], ['lastModified']])),
            renewedTime: normalizeDate(fromPaths(best, [['renewedTime'], ['renewedAt']])),
            attributes,
            batteryInformation: fromPaths(best, [['batteryInformation'], ['battery']]) || null,
            features,
            images,
        };

        log.info('Vehicle scraped', { id: output.id, url: output.url, title: output.title });
        await Dataset.pushData(output);
    },
});

await crawler.run([targetUrl]);

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();

function isAccessDenied(html) {
    const normalized = String(html ?? '').toLowerCase();
    return (
        normalized.includes('zugriff verweigert')
        || normalized.includes('access denied')
        || normalized.includes('automated access to this page was denied')
        || normalized.includes('reference error:')
    );
}

function extractIdFromUrl(url) {
    const match = String(url).match(/\/(\d+)\.html(?:\?|$)/);
    return match ? Number(match[1]) : null;
}

function splitTitle(title) {
    if (!title) return [null, null];
    const idx = title.indexOf('-');
    if (idx === -1) return [title, null];
    return [title.slice(0, idx).trim(), title.slice(idx).trim() || null];
}

function cleanText(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function safeParseJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function tryExtractAssignedJson(scriptText, assignment) {
    const prefixIndex = scriptText.indexOf(assignment);
    if (prefixIndex === -1) return null;
    const start = scriptText.indexOf('{', prefixIndex);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < scriptText.length; i++) {
        const char = scriptText[i];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') inString = false;
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') depth += 1;
        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return safeParseJson(scriptText.slice(start, i + 1));
            }
        }
    }
    return null;
}

function extractEmbeddedJsonObjects($, html) {
    const out = [];

    $('script').each((_, script) => {
        const type = String($(script).attr('type') ?? '').toLowerCase();
        const text = ($(script).html() ?? '').trim();
        if (!text) return;

        if (type.includes('application/ld+json')) {
            const parsed = safeParseJson(text);
            if (parsed) out.push(parsed);
            return;
        }

        const direct = text.startsWith('{') || text.startsWith('[') ? safeParseJson(text) : null;
        if (direct) out.push(direct);

        const nextData = tryExtractAssignedJson(text, 'window.__NEXT_DATA__ =');
        if (nextData) out.push(nextData);

        const initialState = tryExtractAssignedJson(text, 'window.__INITIAL_STATE__ =');
        if (initialState) out.push(initialState);

        const apolloState = tryExtractAssignedJson(text, '__APOLLO_STATE__ =');
        if (apolloState) out.push(apolloState);
    });

    const htmlLd = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const [, jsonText] of htmlLd) {
        const parsed = safeParseJson(jsonText.trim());
        if (parsed) out.push(parsed);
    }

    return out;
}

function walkObjects(root, onObject) {
    if (root === null || root === undefined) return;
    if (Array.isArray(root)) {
        for (const item of root) walkObjects(item, onObject);
        return;
    }
    if (typeof root !== 'object') return;
    onObject(root);
    for (const value of Object.values(root)) walkObjects(value, onObject);
}

function findBestAdCandidate(roots, adId) {
    const candidates = [];
    for (const root of roots) {
        walkObjects(root, (obj) => {
            const idLike = obj?.id ?? obj?.adId ?? obj?.advertId ?? obj?.classifiedId;
            const hasPrice = obj?.price || obj?.offers || obj?.priceAmount;
            const hasTitle = obj?.title || obj?.name || obj?.headline;
            if ((idLike && String(idLike).includes(String(adId ?? ''))) || (hasPrice && hasTitle)) {
                candidates.push(obj);
            }
        });
    }

    if (!candidates.length) return {};
    if (!adId) return candidates[0];

    const exact = candidates.find((obj) => {
        const idLike = obj?.id ?? obj?.adId ?? obj?.advertId ?? obj?.classifiedId;
        return Number(idLike) === Number(adId);
    });
    return exact ?? candidates[0];
}

function pickVehicleLd(roots) {
    for (const root of roots) {
        const queue = [root];
        while (queue.length) {
            const item = queue.shift();
            if (!item) continue;
            if (Array.isArray(item)) {
                queue.push(...item);
                continue;
            }
            if (typeof item !== 'object') continue;

            const typeValue = item['@type'];
            const types = Array.isArray(typeValue) ? typeValue : [typeValue];
            if (types.some((t) => /vehicle|car|product/i.test(String(t)))) {
                return item;
            }

            for (const value of Object.values(item)) queue.push(value);
        }
    }
    return {};
}

function fromPaths(source, paths) {
    if (!source || typeof source !== 'object') return null;
    for (const path of paths) {
        let value = source;
        for (const key of path) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                value = undefined;
                break;
            }
        }
        if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return null;
}

function extractAttributesFromDom($) {
    const attributes = {};

    $('dl').each((_, dl) => {
        const terms = $(dl).find('dt');
        terms.each((__, dt) => {
            const key = cleanText($(dt).text());
            if (!key) return;
            const value = cleanText($(dt).next('dd').text());
            attributes[key] = value || null;
        });
    });

    $('[data-testid*="attributes"] [data-testid*="label"]').each((_, labelEl) => {
        const key = cleanText($(labelEl).text());
        const value = cleanText($(labelEl).parent().find('[data-testid*="value"]').first().text());
        if (key && !(key in attributes)) attributes[key] = value || null;
    });

    return attributes;
}

function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function formatPrice(amount, currency) {
    if (amount === null || amount === undefined) return null;
    try {
        return new Intl.NumberFormat('de-DE', {
            style: 'currency',
            currency: currency || 'EUR',
            maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
        }).format(amount);
    } catch {
        return `${amount} ${currency || 'EUR'}`;
    }
}

function normalizeDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapProperties(attributes) {
    return {
        milage: attributes.Mileage || attributes.Kilometerstand || null,
        gearbox: attributes.Transmission || attributes.Getriebe || null,
        fuelType: attributes.Fuel || attributes.Kraftstoff || null,
        power: attributes.Power || attributes.Leistung || null,
        firstRegistration: attributes['First Registration'] || attributes.Erstzulassung || null,
        seats: attributes['Number of Seats'] || attributes.Sitze || null,
        doors: attributes['Door Count'] || attributes.Türen || null,
        generalInspection: attributes.HU || attributes['General Inspection'] || null,
        lastService: attributes['Last Service'] || null,
        lastServiceMilage: attributes['Last Service Mileage'] || null,
        productionDate: attributes['Production Date'] || null,
        engineSize: attributes['Cubic Capacity'] || attributes.Hubraum || null,
        cylinders: attributes.Cylinders || attributes.Zylinder || null,
        emptyWeight: attributes.Weight || attributes['Empty weight'] || null,
        emissionClass: attributes['Emission Class'] || null,
        emissionSticker: attributes['Emissions Sticker'] || null,
        co2Emission: attributes['CO₂ emissions (comb.)'] || attributes['CO2 emissions (comb.)'] || null,
        co2Class: attributes['CO₂ class'] || attributes['CO2 class'] || null,
        fuelConsumption: normalizeList(attributes['Fuel consumption']),
        costPer1500km: attributes['Cost per 1500km'] || null,
        colour: attributes.Colour || attributes.Farbe || null,
        manufacturerColour: attributes['Colour (Manufacturer)'] || null,
        upholstery: attributes['Interior Design'] || null,
        countryVersion: attributes.Origin || null,
        vehicleNumber: attributes['Vehicle number'] || null,
        numberOfOwners: attributes['Number of Vehicle Owners'] || null,
        climatisation: attributes.Climatisation || null,
        parkingSensors: attributes['Parking sensors'] || null,
        airbags: attributes.Airbags || null,
        tankCapacity: attributes['Tank capacity'] || null,
        range: attributes.Range || null,
        powerConsumption: attributes['Power consumption'] || null,
        energyConsumption: attributes['Energy consumption (comb.)'] || null,
        otherEnergySources: attributes['Other energy sources'] || null,
        driveType: attributes['Drive type'] || null,
    };
}

function normalizeList(value) {
    if (!value) return null;
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
    const text = cleanText(value);
    if (!text) return null;
    const items = text.split(/\s*\|\s*|\s*;\s*/).map(cleanText).filter(Boolean);
    return items.length > 1 ? items : [text];
}

function extractImages(best, ld, $) {
    const list = [];
    const add = (value) => {
        if (!value) return;
        if (Array.isArray(value)) {
            value.forEach(add);
            return;
        }
        const url = cleanText(value);
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (!list.includes(url)) list.push(url);
    };

    add(fromPaths(best, [['images'], ['imageUrls'], ['gallery', 'images'], ['media', 'images']]));
    add(fromPaths(ld, [['image']]));
    $('img').each((_, img) => {
        add($(img).attr('src'));
        add($(img).attr('data-src'));
    });

    return list;
}

function extractFeatures(best, $) {
    const list = [];
    const add = (value) => {
        const normalized = cleanText(value);
        if (!normalized || normalized.length > 120) return;
        if (!list.includes(normalized)) list.push(normalized);
    };

    const fromJson = fromPaths(best, [['features'], ['equipment'], ['equipmentList']]);
    if (Array.isArray(fromJson)) {
        fromJson.forEach((item) => {
            if (typeof item === 'string') add(item);
            if (item && typeof item === 'object') add(item.name ?? item.label ?? item.value);
        });
    }

    $('[data-testid*="equipment"] li, [class*="equipment"] li').each((_, li) => add($(li).text()));
    return list;
}

function guessIsNew(attributes, best) {
    const value = String(
        attributes['Vehicle condition']
        || attributes.Fahrzeugzustand
        || fromPaths(best, [['condition'], ['vehicleCondition']])
        || '',
    ).toLowerCase();
    return value.includes('new') || value.includes('neu');
}

function guessIsDamaged(attributes, best) {
    const value = String(
        attributes['Vehicle condition']
        || attributes.Fahrzeugzustand
        || fromPaths(best, [['condition'], ['vehicleCondition']])
        || '',
    ).toLowerCase();
    return value.includes('accident') || value.includes('unfall');
}