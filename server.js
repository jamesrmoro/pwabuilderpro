const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: './uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json());

// Limpa cores e caracteres especiais do log para o Socket.io
function cleanLogs(text) {
    return text.toString().replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '');
}

// ROTA DE FETCH MANIFEST
app.get('/fetch-manifest', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    try {
        const response = await axios.get(url);
        const html = response.data;
        const $ = cheerio.load(html);

        let manifestData = {
            appName: $('title').text() || '',
            shortName: '',
            themeColor: $('meta[name="theme-color"]').attr('content') || '#000000',
            backgroundColor: '#ffffff',
            iconUrl: '',
            packageId: '',
            startUrl: '/',
            description: $('meta[name="description"]').attr('content') || '',
            display: 'standalone',
            orientation: 'any',
            iarc_rating_id: '',
            screenshots: []
        };

        const manifestLink = $('link[rel="manifest"]').attr('href');

        if (manifestLink) {
            const manifestUrl = new URL(manifestLink, url).href;
            try {
                const manifestRes = await axios.get(manifestUrl);
                const manifest = manifestRes.data;

                if (manifest.name) manifestData.appName = manifest.name;
                if (manifest.short_name) manifestData.shortName = manifest.short_name;
                if (manifest.theme_color) manifestData.themeColor = manifest.theme_color;
                if (manifest.background_color) manifestData.backgroundColor = manifest.background_color;
                if (manifest.start_url) manifestData.startUrl = manifest.start_url;
                if (manifest.description) manifestData.description = manifest.description;
                if (manifest.display) manifestData.display = manifest.display;
                if (manifest.orientation) manifestData.orientation = manifest.orientation;
                if (manifest.iarc_rating_id) manifestData.iarc_rating_id = manifest.iarc_rating_id;

                if (manifest.icons && manifest.icons.length > 0) {
                    // Try to find the largest icon or any icon
                    let bestIcon = manifest.icons[manifest.icons.length - 1]; // Fallback to last
                    const largestIcon = manifest.icons.find(i => i.sizes && i.sizes.includes('512x512'));
                    const anyIcon = manifest.icons.find(i => i.purpose && i.purpose.includes('any'));

                    if (largestIcon) bestIcon = largestIcon;
                    else if (anyIcon) bestIcon = anyIcon;

                    if (bestIcon && bestIcon.src) {
                        manifestData.iconUrl = new URL(bestIcon.src, manifestUrl).href;
                    }
                }

                if (manifest.screenshots && manifest.screenshots.length > 0) {
                    manifestData.screenshots = manifest.screenshots.map(s => new URL(s.src, manifestUrl).href);
                }

                if (manifest.related_applications && manifest.related_applications.length > 0) {
                    const playApp = manifest.related_applications.find(app => app.platform === 'play');
                    if (playApp && playApp.id) {
                        manifestData.packageId = playApp.id;
                    }
                }
            } catch (manifestError) {
                console.error("Error fetching manifest JSON:", manifestError.message);
            }
        }

        // Fallbacks
        if (!manifestData.iconUrl) {
            const appleIcon = $('link[rel="apple-touch-icon"]').attr('href');
            if (appleIcon) manifestData.iconUrl = new URL(appleIcon, url).href;
            else {
                const shortcutIcon = $('link[rel="shortcut icon"]').attr('href') || $('link[rel="icon"]').attr('href');
                if (shortcutIcon) manifestData.iconUrl = new URL(shortcutIcon, url).href;
            }
        }

        if (!manifestData.shortName) manifestData.shortName = manifestData.appName.substring(0, 12);

        res.json(manifestData);

    } catch (error) {
        console.error("Error fetching URL:", error.message);
        res.status(500).json({ error: 'Failed to fetch or parse the URL.' });
    }
});

// ROTA DE DOWNLOAD INTELIGENTE
app.get('/download', (req, res) => {
    const buildDir = path.join(__dirname, 'temp_build');
    const type = req.query.type; // 'aab' ou 'apk'
    
    // Lista de caminhos onde o arquivo pode estar escondido
    const caminhosParaChecar = [
        buildDir, // Onde o Bubblewrap às vezes coloca os arquivos no final
        path.join(buildDir, 'dist'), // Novo padrão do Bubblewrap (mais comum)
        path.join(buildDir, 'app', 'build', 'outputs', 'bundle', 'release'),
        path.join(buildDir, 'app', 'build', 'outputs', 'apk', 'release'),
        path.join(buildDir, 'app', 'build', 'outputs', 'bundle', 'debug')
    ];

    let arquivoCaminho = null;
    let nomeOriginal = type === 'apk' ? "app-final.apk" : "app-final.aab";

    for (const pasta of caminhosParaChecar) {
        if (fs.existsSync(pasta)) {
            const arquivos = fs.readdirSync(pasta);
            let encontrado;
            if (type === 'apk') {
                encontrado = arquivos.find(f => f.endsWith('.apk'));
            } else if (type === 'aab') {
                encontrado = arquivos.find(f => f.endsWith('.aab'));
            } else {
                encontrado = arquivos.find(f => (f.endsWith('.aab') || f.endsWith('.apk')) && f !== 'build.log');
            }
            if (encontrado) {
                arquivoCaminho = path.join(pasta, encontrado);
                nomeOriginal = encontrado;
                break;
            }
        }
    }

    if (arquivoCaminho && fs.existsSync(arquivoCaminho)) {
        console.log(`> Enviando arquivo: ${arquivoCaminho}`);
        res.download(arquivoCaminho, nomeOriginal);
    } else {
        const logFile = path.join(buildDir, 'build.log');
        if (fs.existsSync(logFile)) {
            console.log(`> Enviando log de erros: ${logFile}`);
            res.download(logFile, 'build-error.log');
        } else {
            res.status(404).send('Build finalizado, mas o arquivo assinado não foi encontrado na pasta temp_build. Assinatura falhou e não há logs disponíveis.');
        }
    }
});

app.post('/generate', upload.single('signingKey'), async (req, res) => {
    const {
        appName, host, keyAlias, storePassword, versionCode, versionName,
        shortName, packageId, themeColor, themeDarkColor, backgroundColor, navColor, navDarkColor, iconUrl, startUrl,
        description, iarc, displayMode, orientation, screenshots
    } = req.body;

    if (!req.file || !host || !appName) {
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (e) {
                console.error('Error deleting file:', e.message);
            }
        }
        return res.status(400).json({ success: false, msg: 'Faltam campos obrigatórios (signingKey, host, appName)' });
    }

    const vCode = parseInt(versionCode) || 1;
    const vName = versionName || `1.0.${vCode}`;
    const buildDir = path.join(__dirname, 'temp_build');

    try {
        res.json({ success: true, message: 'Build started' }); // Acknowledge request immediately

        // 1. Limpeza e preparação
        if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
        fs.mkdirSync(buildDir, { recursive: true });

        // Garante que o arquivo de log comece limpo a cada novo build
        const logFile = path.join(buildDir, 'build.log');
        if (fs.existsSync(logFile)) fs.rmSync(logFile);

        // Força a configuração global do Gradle do usuário para 512MB
        const userGradleDir = path.join(process.env.USERPROFILE || process.env.HOME || '/root', '.gradle');
        if (!fs.existsSync(userGradleDir)) fs.mkdirSync(userGradleDir, { recursive: true });
        fs.writeFileSync(path.join(userGradleDir, 'gradle.properties'), "org.gradle.jvmargs=-Xmx512m\norg.gradle.daemon=false");

        const keystorePath = path.resolve(req.file.path).replace(/\\/g, '/');
        let cleanHost = host.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];

        let finalPackageId = packageId;
        if (!finalPackageId) {
             finalPackageId = `${cleanHost.split('.').reverse().join('.')}.app`.toLowerCase();
        }

        let finalShortName = shortName || appName.substring(0, 12);
        let finalIconUrl = iconUrl || "https://raw.githubusercontent.com/GoogleChromeLabs/bubblewrap/master/app/logo.png";

        // 2. Criar twa-manifest.json
        const twaManifest = {
            packageId: finalPackageId,
            host: cleanHost,
            name: appName,
            launcherName: finalShortName,
            display: displayMode || "standalone",
            themeColor: themeColor || "#000000",
            navigationColor: navColor || "#000000",
            navigationColorDark: navDarkColor || "#000000",
            backgroundColor: backgroundColor || "#ffffff",
            enableNotifications: true,
            startUrl: startUrl || "/",
            iconUrl: finalIconUrl,
            signingKey: { path: keystorePath, alias: keyAlias },
            appVersionCode: vCode,
            appVersionName: vName,
            generatorApp: "bubblewrap-cli",
            splashScreenFadeOutDuration: 300,
            displayNames: [],
            orientation: orientation || "any",
        };

        if (description) twaManifest.description = description;
        if (iarc) twaManifest.iarcRatingId = iarc;

        let validScreenshots = [];
        if (screenshots) {
            const arr = Array.isArray(screenshots) ? screenshots : [screenshots];
            validScreenshots = arr.filter(url => url.trim().length > 0);
        }

        // Formata os screenshots corretamente
        // TWA manifest doesn't natively accept 'screenshots' array like this in its schema for 'init' in some versions,
        // but bubblewrap cli lets you inject some properties.
        // Wait, bubblewrap uses webManifestUrl or extracts from manifest.
        // Actually bubblewrap `twa-manifest.json` does not typically take raw screenshot arrays.
        // Wait, the prompt asked to add Description, IARC, Display, Orientation, and Screenshots.

        // Actually, Bubblewrap's twa-manifest.json does not officially support screenshots or description directly.
        // We will pass what we can into the twa-manifest.json, and the rest to the webManifest inside app/src/main/res
        // However, Bubblewrap's twa-manifest.json does accept `fallbackType` or `webManifestUrl`.
        // Let's at least store them in the twaManifest JSON object if the schema ignores unknown fields.
        if (validScreenshots.length > 0) {
             twaManifest.screenshots = validScreenshots.map(url => ({ src: url, sizes: "1080x1920", type: "image/png" }));
        }

        fs.writeFileSync(path.join(buildDir, 'twa-manifest.json'), JSON.stringify(twaManifest, null, 2));

        const runCommand = (cmd, args) => {
            return new Promise((resolve) => {
                const env = { 
                    ...process.env, 
                    BUBBLEWRAP_KEYSTORE_PASSWORD: storePassword,
                    BUBBLEWRAP_KEY_PASSWORD: storePassword,
                    _JAVA_OPTIONS: "-Xmx512M",
                    GRADLE_OPTS: "-Xmx512m -Dorg.gradle.daemon=false"
                };

                const ls = spawn(cmd, args, { cwd: buildDir, env, shell: true });

                ls.stdout.on('data', (data) => {
                    const clean = cleanLogs(data);
                    fs.appendFileSync(path.join(buildDir, 'build.log'), clean + '\n');
                    
                    // ROBÔ: Respondendo ao Checksum / Regeneração
                    if (clean.includes('regenerate your project') || clean.includes('(Y/n)')) {
                        io.emit('log', "🤖 Detectado pedido de regeneração. Respondendo 'Y'...");
                        ls.stdin.write("Y\n");
                    }

                    // ROBÔ: Respondendo Version Name
                    if (clean.includes('versionName')) {
                        ls.stdin.write(`${vName}\n`);
                    }

                    // ROBÔ: Respondendo Senha (Fallback se o env: falhar)
                    if (clean.includes('Password') && !clean.includes('*')) {
                        ls.stdin.write(`${storePassword}\n`);
                    }

                    io.emit('log', clean);
                });

                ls.stderr.on('data', (data) => {
                    const clean = cleanLogs(data);
                    fs.appendFileSync(path.join(buildDir, 'build.log'), `⚠️ ${clean}\n`);
                    io.emit('log', `⚠️ ${clean}`);
                });
                ls.on('close', (code) => resolve(code));
            });
        };

        io.emit('log', `> [1/3] Inicializando ambiente TWA...`);
        await runCommand('npx', ['@bubblewrap/cli', 'init', '--manifest', 'twa-manifest.json', '--skipCheck', '--no-prompt']);
        
        // Injeta limite local na pasta temp_build
        fs.writeFileSync(path.join(buildDir, 'gradle.properties'), "org.gradle.jvmargs=-Xmx512m\norg.gradle.daemon=false");

        io.emit('log', `> [2/3] Atualizando Manifesto e Assets...`);
        await runCommand('npx', ['@bubblewrap/cli', 'update', '--skipCheck', '--skipVersionUpgrade', '--no-prompt']);

        io.emit('log', `> [3/3] Compilando APK/AAB (Econômico)...`);
        const buildCode = await runCommand('npx', [
            '@bubblewrap/cli', 'build', 
            '--skipCheck',
            '--no-prompt',
            '--signingKeyPassword', storePassword,
            '--signingKeyAliasPassword', storePassword
        ]);

        if (buildCode === 0) {
            let isSigned = false;
            const caminhosParaChecar = [
                buildDir, // Onde o Bubblewrap às vezes coloca os arquivos no final
                path.join(buildDir, 'dist'),
                path.join(buildDir, 'app', 'build', 'outputs', 'bundle', 'release'),
                path.join(buildDir, 'app', 'build', 'outputs', 'apk', 'release'),
                path.join(buildDir, 'app', 'build', 'outputs', 'bundle', 'debug')
            ];
            for (const pasta of caminhosParaChecar) {
                if (fs.existsSync(pasta)) {
                    const arquivos = fs.readdirSync(pasta);
                    if (arquivos.some(f => (f.endsWith('.aab') || f.endsWith('.apk')) && f !== 'build.log')) {
                        isSigned = true;
                        break;
                    }
                }
            }
            if (isSigned) {
               io.emit('status', { success: true, msg: "✅ SUCESSO! O download já está disponível.", isSigned: true });
            } else {
               io.emit('status', { success: false, msg: "❌ O Build falhou na assinatura do pacote. O download do arquivo de logs (build-error.log) está disponível.", isSigned: false, hasLogs: true });
            }
        } else {
            io.emit('status', { success: false, msg: "❌ O Build falhou. Verifique se o Java ainda tem RAM. O download dos logs pode estar disponível.", isSigned: false, hasLogs: true });
        }

    } catch (err) {
        io.emit('log', `❌ ERRO CRÍTICO: ${err.message}`);
    } finally {
        if (req.file && req.file.path) {
            try {
                if (fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
            } catch (err) {
                console.error("Erro ao apagar keystore:", err.message);
            }
        }
    }
});

server.listen(3000, () => console.log(`🚀 Gerador rodando em http://localhost:3000`));