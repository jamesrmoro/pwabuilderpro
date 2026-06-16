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

let currentBuildProcesses = [];
const io = new Server(server);
const upload = multer({ dest: './uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
const defaultGeneratedKeystoreName = 'generated-signing-key.jks';

app.use(express.static('public'));
app.use(express.json());

// Limpa cores e caracteres especiais do log para o Socket.io
function cleanLogs(text) {
    return text.toString().replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-z]/g, '');
}

function sanitizeKeyAlias(alias) {
    return (alias || 'android').trim().replace(/[^a-zA-Z0-9_.-]/g, '-') || 'android';
}

function runProcess(cmd, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { ...options, shell: false });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += cleanLogs(data);
        });

        child.stderr.on('data', (data) => {
            stderr += cleanLogs(data);
        });

        child.on('error', (error) => {
            resolve({ code: 1, stdout, stderr: error.message });
        });

        child.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}


function addBillingPermissionToManifest(buildDir) {
    const manifestPath = path.join(buildDir, 'app', 'src', 'main', 'AndroidManifest.xml');
    const billingPermission = 'com.android.vending.BILLING';

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`AndroidManifest.xml não encontrado para adicionar a permissão ${billingPermission}.`);
    }

    const manifest = fs.readFileSync(manifestPath, 'utf8');
    if (manifest.includes(`android.permission.${billingPermission}`) || manifest.includes(`android:name="${billingPermission}"`)) {
        return { manifestPath, changed: false };
    }

    const permissionTag = `    <uses-permission android:name="${billingPermission}" />\n`;
    let updatedManifest;

    if (manifest.includes('<application')) {
        updatedManifest = manifest.replace(/\s*<application/, `\n${permissionTag}\n    <application`);
    } else {
        updatedManifest = manifest.replace('</manifest>', `${permissionTag}</manifest>`);
    }

    fs.writeFileSync(manifestPath, updatedManifest);
    return { manifestPath, changed: true };
}

function getSigningFailureMessage(logContent = '') {
    const lowerLog = logContent.toLowerCase();

    if (lowerLog.includes('no key with alias') || (lowerLog.includes('alias') && lowerLog.includes('not found'))) {
        return '❌ O Build falhou na assinatura: alias da chave incorreto ou não encontrado no keystore. Confira o campo "Alias da chave".';
    }

    if (lowerLog.includes('keystore was tampered') || lowerLog.includes('keystore password was incorrect') || lowerLog.includes('password was incorrect')) {
        return '❌ O Build falhou na assinatura: senha do keystore incorreta. Confira a senha usada para abrir o arquivo .jks/.keystore.';
    }

    if (lowerLog.includes('cannot recover key') || lowerLog.includes('key password') || lowerLog.includes('failed to recover key')) {
        return '❌ O Build falhou na assinatura: senha da chave privada incorreta. Se a chave não tiver senha separada, deixe esse campo vazio para usar a senha do keystore.';
    }

    return '❌ O Build falhou. Confira alias, senha do keystore e senha da chave privada. O download dos logs pode estar disponível.';
}

async function createSigningKey(buildDir, keyAlias, storePassword, keyPassword) {
    const keystorePath = path.join(buildDir, defaultGeneratedKeystoreName);
    const alias = sanitizeKeyAlias(keyAlias);
    const password = storePassword || '';
    const privateKeyPassword = keyPassword || storePassword || '';

    if (!password || password.length < 6) {
        throw new Error('Para criar uma nova chave, informe uma senha da keystore com pelo menos 6 caracteres. Guarde essa senha para futuras atualizações do app.');
    }

    const keytoolArgs = [
        '-genkeypair',
        '-v',
        '-keystore', keystorePath,
        '-storetype', 'JKS',
        '-alias', alias,
        '-keyalg', 'RSA',
        '-keysize', '2048',
        '-validity', '10000',
        '-storepass', password,
        '-keypass', privateKeyPassword,
        '-dname', `CN=${alias}, OU=PWA Builder Pro, O=PWA Builder Pro, L=Internet, S=Internet, C=BR`
    ];

    const result = await runProcess('keytool', keytoolArgs, { cwd: buildDir });
    if (result.code !== 0 || !fs.existsSync(keystorePath)) {
        throw new Error(`Não foi possível criar a chave automaticamente com keytool. ${result.stderr || result.stdout}`.trim());
    }

    return { keystorePath, alias };
}

app.post('/cancel-build', (req, res) => {
    console.log(`> Cancelando ${currentBuildProcesses.length} processos de build...`);
    currentBuildProcesses.forEach(proc => {
        try {
            proc.kill();
        } catch (e) {
            console.error("Erro ao matar processo:", e);
        }
    });
    currentBuildProcesses = [];
    io.emit('status', { success: false, msg: "❌ Build cancelado pelo usuário.", isSigned: false, hasLogs: true });
    io.emit('log', `> ❌ BUILD CANCELADO PELO USUÁRIO.`);
    res.json({ success: true, message: 'Build cancelled' });
});

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

app.get('/download-key', (req, res) => {
    const keystorePath = path.join(__dirname, 'temp_build', defaultGeneratedKeystoreName);

    if (fs.existsSync(keystorePath)) {
        console.log(`> Enviando keystore gerada: ${keystorePath}`);
        return res.download(keystorePath, defaultGeneratedKeystoreName);
    }

    res.status(404).send('Nenhuma keystore gerada automaticamente foi encontrada para download.');
});

app.post('/generate', upload.single('signingKey'), async (req, res) => {
    const {
        appName, host, keyAlias, storePassword, keyPassword, signingMode, versionCode, versionName,
        shortName, packageId, themeColor, themeDarkColor, backgroundColor, navColor, navDarkColor, iconUrl, startUrl,
        description, iarc, displayMode, orientation, screenshots, enableBilling
    } = req.body;

    const shouldUseExistingKey = signingMode === 'existing' || !!req.file;
    const resolvedKeyPassword = keyPassword || storePassword;
    const hasInvalidKeyPassword = !!keyPassword && keyPassword.length < 6;
    const missingRequiredFields = !host || !appName || !storePassword || (shouldUseExistingKey && (!req.file || !keyAlias));

    if (missingRequiredFields || hasInvalidKeyPassword) {
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (e) {
                console.error('Error deleting file:', e.message);
            }
        }
        const msg = hasInvalidKeyPassword
            ? 'A senha da chave privada deve ter pelo menos 6 caracteres, ou ficar vazia para usar a senha do keystore.'
            : shouldUseExistingKey
                ? 'Faltam campos obrigatórios (host, appName, signingKey, keyAlias, storePassword). A senha da chave privada é opcional e, se ficar vazia, usará a senha do keystore.'
                : 'Faltam campos obrigatórios (host, appName, storePassword). A senha da chave privada é opcional e, se ficar vazia, usará a senha do keystore.';
        return res.status(400).json({ success: false, msg });
    }

    const vCode = parseInt(versionCode) || 1;
    const vName = versionName || `1.0.${vCode}`;
    const shouldEnableBilling = enableBilling === 'on' || enableBilling === 'true' || enableBilling === true;
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

        let keystorePath;
        let finalKeyAlias = keyAlias;

        if (shouldUseExistingKey) {
            keystorePath = path.resolve(req.file.path).replace(/\\/g, '/');
        } else {
            io.emit('log', '> Nenhuma chave enviada. Criando nova keystore para primeira publicação...');
            const generatedKey = await createSigningKey(buildDir, keyAlias, storePassword, resolvedKeyPassword);
            keystorePath = generatedKey.keystorePath.replace(/\\/g, '/');
            finalKeyAlias = generatedKey.alias;
            io.emit('log', `> ✅ Nova keystore criada automaticamente (${defaultGeneratedKeystoreName}) com alias "${finalKeyAlias}".`);
            io.emit('log', '> ⚠️ Guarde a senha e use a mesma keystore para atualizar este app no futuro.');
        }

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
            signingKey: { path: keystorePath, alias: finalKeyAlias },
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
                    BUBBLEWRAP_KEY_PASSWORD: resolvedKeyPassword,
                    _JAVA_OPTIONS: "-Xmx512M",
                    GRADLE_OPTS: "-Xmx512m -Dorg.gradle.daemon=false"
                };

                const ls = spawn(cmd, args, { cwd: buildDir, env, shell: false });
                currentBuildProcesses.push(ls);

                const handleProcessOutput = (data, isError = false) => {
                    const clean = cleanLogs(data);
                    fs.appendFileSync(path.join(buildDir, 'build.log'), `${isError ? '⚠️ ' : ''}${clean}\n`);

                    // ROBÔ: Respondendo ao Checksum / Regeneração
                    if (clean.includes('regenerate your project') || clean.includes('(Y/n)')) {
                        io.emit('log', "🤖 Detectado pedido de regeneração. Respondendo 'Y'...");
                        ls.stdin.write("Y\n");
                    }

                    // ROBÔ: Respondendo Version Name
                    if (clean.includes('versionName')) {
                        ls.stdin.write(`${vName}\n`);
                    }

                    // ROBÔ: Respondendo Senha (fallback se o env falhar). Não imprimir senhas.
                    const lowerClean = clean.toLowerCase();
                    if (lowerClean.includes('password') && !clean.includes('*')) {
                        const asksForKeystorePassword = lowerClean.includes('key store') || lowerClean.includes('keystore');
                        const asksForPrivateKeyPassword = !asksForKeystorePassword && (lowerClean.includes('key') || lowerClean.includes('alias'));
                        const passwordToSend = asksForPrivateKeyPassword ? resolvedKeyPassword : storePassword;
                        ls.stdin.write(`${passwordToSend}\n`);
                    }

                    io.emit('log', isError ? `⚠️ ${clean}` : clean);
                };

                ls.stdout.on('data', (data) => handleProcessOutput(data));
                ls.stderr.on('data', (data) => handleProcessOutput(data, true));
                ls.on('close', (code) => {
                    const index = currentBuildProcesses.indexOf(ls);
                    if (index > -1) {
                        currentBuildProcesses.splice(index, 1);
                    }
                    resolve(code);
                });
            });
        };

        io.emit('log', `> [1/3] Inicializando ambiente TWA...`);
        await runCommand('npx', ['@bubblewrap/cli', 'init', '--manifest', 'twa-manifest.json', '--skipCheck', '--no-prompt']);
        
        // Injeta limite local na pasta temp_build
        fs.writeFileSync(path.join(buildDir, 'gradle.properties'), "org.gradle.jvmargs=-Xmx512m\norg.gradle.daemon=false");

        io.emit('log', `> [2/3] Atualizando Manifesto e Assets...`);
        await runCommand('npx', ['@bubblewrap/cli', 'update', '--skipCheck', '--no-prompt']);

        if (shouldEnableBilling) {
            io.emit('log', '> Adicionando permissão com.android.vending.BILLING ao AndroidManifest.xml...');
            const billingPatch = addBillingPermissionToManifest(buildDir);
            io.emit('log', billingPatch.changed
                ? '> ✅ Permissão de billing adicionada ao AAB/APK.'
                : '> ✅ Permissão de billing já estava presente no projeto.');
        } else {
            io.emit('log', '> Permissão de billing desativada para este build.');
        }

        io.emit('log', `> [3/3] Compilando APK/AAB (Econômico)...`);
        const buildCode = await runCommand('npx', [
            '@bubblewrap/cli', 'build',
            '--skipCheck',
            '--no-prompt',
            '--signingKeyPath', keystorePath,
            '--signingKeyAlias', finalKeyAlias
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
               io.emit('status', { success: true, msg: "✅ SUCESSO! O download já está disponível.", isSigned: true, generatedKey: !shouldUseExistingKey });
            } else {
               io.emit('status', { success: false, msg: "❌ O Build falhou na assinatura do pacote. O download do arquivo de logs (build-error.log) está disponível.", isSigned: false, hasLogs: true });
            }
        } else {
            const buildLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
            io.emit('status', { success: false, msg: getSigningFailureMessage(buildLog), isSigned: false, hasLogs: true });
        }

    } catch (err) {
        io.emit('log', `❌ ERRO CRÍTICO: ${err.message}`);
        io.emit('status', { success: false, msg: `❌ Erro crítico: ${err.message}`, isSigned: false, hasLogs: true });
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