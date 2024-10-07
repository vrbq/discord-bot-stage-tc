const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const yargs = require('yargs');
const { Client, GatewayIntentBits } = require('discord.js'); // Import correct de discord.js
const { google } = require('googleapis');
const { promisify } = require('util');
const cron = require('node-cron');

require('dotenv').config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_TOKEN_CHANNEL_TEXT_TO_PDF =
  process.env.DISCORD_TOKEN_CHANNEL_TEXT_TO_PDF;
const DISCORD_TOKEN_CHANNEL_OFFERS =
  process.env.DISCORD_TOKEN_CHANNEL_OFFERS;
const FOLDER_ID = process.env.FOLDER_ID;

// Google Drive credentials and token path

const SCOPES = process.env.SCOPES;
const TOKEN_PATH = process.env.TOKEN_PATH;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;

// Client Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let knownFiles = new Set();

const logFilePath = path.join(__dirname, 'app.log');

console.log('Log file created');

const logDir = __dirname; // Utilise le répertoire courant de l'application

async function rmLog() {
  const currentDirectory = process.cwd(); // Dossier courant

  // 1. Suppression des fichiers .log
  try {
    const files = await fs.promises.readdir(currentDirectory);

    for (const file of files) {
      if (file.endsWith('.log')) {
        await fs.promises.unlink(path.join(currentDirectory, file));
        console.log(`Supprimé : ${file}`);
      }
    }

    // 2. Vérification de la suppression (optionnel)
    const remainingFiles = await fs.promises.readdir(
      currentDirectory
    );
    const logFiles = remainingFiles.filter((file) =>
      file.endsWith('.log')
    );

    if (logFiles.length === 0) {
      console.log(
        'Tous les fichiers .log ont été supprimés avec succès.'
      );
    } else {
      console.warn(
        "Certains fichiers .log n'ont pas pu être supprimés."
      );
    }

    // 3. Recréation du fichier app.log
    const appLogPath = path.join(currentDirectory, 'app.log');
    await fs.promises.writeFile(appLogPath, '');
    console.log('Fichier app.log recréé avec succès.');
  } catch (error) {
    console.error('Erreur lors du redémarrage :', error);
  }
}

async function restartApp() {
  rmLog();
  refreshAccessToken();
  connexionToDiscord();
}

cron.schedule('0 0 * * *', () => {
  console.log('Running daily reload app at 00:00 ...');
  restartApp();
  console.error('App has been reloaded !', err);
});

// Fonction pour écrire dans le fichier de log
function writeToLog(message) {
  const now = new Date();
  const logMessage = `[${now.toLocaleString()}] ${message}\n`;
  const byPassString = '[BYPASS]';
  if (!message.includes(byPassString)) {
    fs.appendFile(logFilePath, logMessage, (err) => {
      if (err) {
        console.error('Error writing to log file:', err);
      }
    });
  }
}

// Sauvegardez la fonction originale de console.log
console._log = console.log;

console.log = function (message) {
  if (
    typeof message !== 'string' ||
    !message.startsWith('[FILE LOG]')
  ) {
    writeToLog(message); // Écrire dans le fichier de log
  }
  console._log.apply(console, arguments); // Appel de la fonction originale de console.log
};

// Exemple d'un console.log classique

// Rediriger console.log vers writeToLog
console.log = writeToLog;

// Maintenant, tous les console.log seront redirigés vers le fichier de log

async function initializeFiles(auth, channel) {
  console.log('Initializing files...');
  const drive = google.drive({ version: 'v3', auth });

  try {
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)',
    });
    const files = res.data.files;
    if (files.length) {
      console.log('Sending initial file list...');
      let message = 'Voici tous les fichiers :\n';
      files.forEach((file) => {
        message += `- ${file.name}\n`;
        knownFiles.add(file.id);
      });
      // await channel.send(message); // No need to see all files in discord channel
      console.log(message);
    } else {
      console.log('No files found.');
    }
  } catch (err) {
    console.error('Error initializing files:', err);
  }

  setInterval(() => checkForUpdates(auth, channel), 20 * 1000);
}

// Fonction pour rafraîchir le token
async function refreshAccessToken() {
  try {
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);

    // Vérifier si le token est expiré
    if (oAuth2Client.isTokenExpiring()) {
      // Utiliser le rafraîchissement token pour obtenir un nouveau token d'accès
      const { tokens } = await oAuth2Client.refreshAccessToken();
      oAuth2Client.setCredentials(tokens);

      // Enregistrer le nouveau token d'accès dans le fichier
      await promisify(fs.writeFile)(
        TOKEN_PATH,
        JSON.stringify(tokens)
      );
    }
  } catch (error) {
    console.error('Error refreshing access token:', error);
  }
}

async function fetchList(auth, channel) {
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: `'${process.env.FOLDER_ID}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
    fields: 'files(id, name, webViewLink, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 10, // Adjust this if you want more files
  });

  const files = res.data.files;
  if (files.length) {
    for (const file of files) {
      if (!knownFiles.has(file.id)) {
        console.log(`New file detected: ${file.name}`);

        // Extract details from file name
        const fileName = file.name;
        const [years, enterprise, position] = fileName.split(' - ');
        let title;
        if (position) {
          title = position.split('.');
        } else {
          // Faites quelque chose si position est vide, par exemple :
          title = 'NO_TITLE_DETECTED'; // Si vous voulez que title soit un tableau avec une chaîne vide.
        }

        // Construct message with details and file link
        const message = `
Bonne nouvelle ! Une offre vient d'arriver sur le drive :point_left:
**Année** : ${years}
**Entreprise** : ${enterprise}
**Poste** : ${title[0]}
[Voir l'offre](${file.webViewLink})
`;

        knownFiles.add(file.id);
        await channel.send(message);
      }
    }
  } else {
    console.log('No files found.');
  }
}

async function checkForUpdates(auth, channel) {
  console.log('Checking for updates...');
  const drive = google.drive({ version: 'v3', auth });

  try {
    fetchList(auth, channel);
  } catch (err) {
    console.error('Error checking for updates:', err);
    if (error.code === '401') {
      // Token invalide ou expiré, nécessite un rafraîchissement
      console.log('Token expired, refreshing...');
    } else {
      // Autre type d'erreur, gérer en conséquence
      console.error(
        'Not a 401 error, trying refresh token anyway:',
        error
      );
    }
    try {
      await oAuth2Client.refreshAccessToken();

      oauth2Client.setCredentials({
        refresh_token: `STORED_REFRESH_TOKEN`,
      });

      // Réessayer l'appel API après le rafraîchissement
      setInterval(() => checkForUpdates(auth, channel), 20 * 1000);
      // Utiliser les fichiers récupérés ici
    } catch (refreshError) {
      console.error('Error refreshing access token:', refreshError);
    }
    try {
      refreshAccessToken();
    } catch (error) {
      console.log('refreshAccessToken() did not worked', error);
    }
  }
}

// Fonction pour générer le PDF à partir d'un message Discord
async function processDiscordMessage(messageContent) {
  if (!messageContent || messageContent.trim().length === 0) {
    console.error('Le message est vide.');
    return;
  }

  try {
    const offerData = parseContent(messageContent);
    const outputFileName = generateOutputFileName(offerData);
    generateLatex(offerData, outputFileName);
  } catch (error) {
    console.error(
      `Erreur lors du traitement du message Discord: ${error.message}`
    );
  }
}

// Fonction de parsing du contenu du message
function parseContent(data) {
  const lines = data
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let offerDate = '';
  let targetYears = '';
  let company = '';
  let jobTitle = '';
  let jobDescription = '';
  let link = '';
  let contact = '';

  let captureDescription = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Offre reçue le ')) {
      offerDate = lines[i].replace('Offre reçue le ', '').trim();
    } else if (lines[i].startsWith('Année(s) visée(s) :')) {
      targetYears = lines[i]
        .replace('Année(s) visée(s) :', '')
        .trim();
    } else if (lines[i].startsWith('Entreprise :')) {
      company = lines[i].replace('Entreprise :', '').trim();
    } else if (lines[i].startsWith('Intitulé du poste :')) {
      jobTitle = lines[i].replace('Intitulé du poste :', '').trim();
    } else if (lines[i].startsWith('Descriptif de l’offre :')) {
      captureDescription = true;
      jobDescription = lines[i]
        .replace('Descriptif de l’offre :', '')
        .trim();
      i++; // Move to the next line
      while (
        i < lines.length &&
        !startsWithAny(lines[i], [
          'Lien :',
          'Contact pour des informations supplémentaires :',
        ])
      ) {
        jobDescription += '\n' + lines[i].trim();
        i++;
      }
      i--; // Move back one step to process the line starting with 'Lien :' or 'Contact ...'
    } else if (lines[i].startsWith('Lien :')) {
      link = lines[i].replace('Lien :', '').trim();
    } else if (
      lines[i].startsWith(
        'Contact pour des informations supplémentaires :'
      )
    ) {
      contact = lines[i]
        .replace(
          'Contact pour des informations supplémentaires :',
          ''
        )
        .trim();
    }
  }

  if (
    !offerDate ||
    !targetYears ||
    !company ||
    !jobTitle ||
    !jobDescription ||
    !link ||
    !contact
  ) {
    throw new Error(
      'Tous les champs sont obligatoires et doivent être remplis.'
    );
  }

  return {
    offerDate,
    targetYears,
    company,
    jobTitle,
    jobDescription,
    link,
    contact,
  };
}

function startsWithAny(str, prefixes) {
  return prefixes.some((prefix) => str.startsWith(prefix));
}

function cleanFileName(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Enlève les accents
}

function generateOutputFileName({ targetYears, company, jobTitle }) {
  const fileName = `${cleanFileName(targetYears)} - ${cleanFileName(
    company
  )} - ${cleanFileName(jobTitle)}.pdf`;
  return path.join(__dirname, fileName);
}

function generateLatex(
  {
    offerDate,
    targetYears,
    company,
    jobTitle,
    jobDescription,
    link,
    contact,
  },
  outputFileName
) {
  // Fonction pour extraire une adresse e-mail d'une chaîne
  function extractEmailAddress(str) {
    const emailRegex =
      /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/;
    const match = str.match(emailRegex);
    return match ? match[0] : null;
  }

  // Extraire l'adresse e-mail de la chaîne contact
  const email = extractEmailAddress(contact);

  const noEmail = contact.replace(email, '').trim();

  const ifEmailTrue = noEmail + ` \\href{mailto:${email}}{${email}}`;

  // Générer le contenu LaTeX avec le lien "mailto" si une adresse e-mail est extraite
  const latexContent = `
  \\documentclass{article}
  \\usepackage[T1]{fontenc}
  \\usepackage[utf8]{inputenc}
  \\usepackage{lmodern}
  \\usepackage{textcomp}
  \\usepackage{hyperref}
  \\usepackage{lastpage}
  
  \\title{${jobTitle}}
  \\author{${company}}
  \\date{}
  
  \\begin{document}
  \\normalsize
  \\maketitle
  \\paragraph{Offre reçue le :} ${offerDate}
  \\paragraph{Année(s) visée(s) :} ${targetYears}
  \\paragraph{Entreprise :} ${company}
  \\paragraph{Intitulé du poste :} ${jobTitle}
  \\paragraph{Descriptif de l'offre :} ${jobDescription.trim()}
  \\paragraph{Lien vers l'annonce :} \\href{${link}}{${link}}
  \\paragraph{Contact pour des informations supplémentaires :} ${
    email ? ifEmailTrue : contact
  }
  \\end{document}
    `;

  const latexFilePath = path.join(__dirname, 'offre.tex');
  fs.writeFile(latexFilePath, latexContent, (err) => {
    if (err) {
      console.error(
        `Erreur lors de la génération du fichier LaTeX: ${err}`
      );
      return;
    }
    console.log('Fichier LaTeX généré avec succès!');
    generatePDF(latexFilePath, outputFileName);
  });
}
function generatePDF(latexFilePath, outputFileName) {
  console.log(`Starting PDF generation for ${latexFilePath}...`);

  exec(
    `pdflatex -output-directory=${path.dirname(
      latexFilePath
    )} ${latexFilePath}`,
    (err, stdout, stderr) => {
      if (err) {
        console.error(`Error during PDF generation: ${err}`);
        console.error(`stderr: ${stderr}`);
        return;
      }

      console.log(
        `PDF generated successfully from ${latexFilePath}.`
      );

      const pdfPath = path.join(
        path.dirname(latexFilePath),
        path.basename(latexFilePath, '.tex') + '.pdf'
      );

      console.log(`Renaming PDF file to ${outputFileName}...`);
      fs.rename(pdfPath, outputFileName, (err) => {
        if (err) {
          console.error(`Error renaming PDF file: ${err}`);
          return;
        }

        console.log(`PDF successfully renamed to ${outputFileName}.`);
        console.log(`Uploading PDF to Google Drive...`);
        uploadToGoogleDrive(outputFileName);
        console.log(`Cleaning up temporary files...`);
        cleanupTempFiles(latexFilePath);
        console.log(`PDF generation process completed.`);
      });
    }
  );
}

function cleanupTempFiles(latexFilePath) {
  const tempFiles = ['.aux', '.log', '.out', '.tex'];
  tempFiles.forEach((ext) => {
    const tempFilePath = latexFilePath.replace('.tex', ext);
    fs.unlink(tempFilePath, (err) => {
      if (err) {
        console.warn(
          `Erreur lors de la suppression du fichier temporaire ${tempFilePath}: ${err}`
        );
      } else {
        console.log(`Fichier temporaire supprimé: ${tempFilePath}`);
      }
    });
  });
}

async function sendOKMessage(fileDataID) {
  const channel = await client.channels.fetch(
    DISCORD_TOKEN_CHANNEL_TEXT_TO_PDF
  );

  channel
    .send(
      `BOT : Un nouveau fichier a été ajouté sur Google Drive : ${fileDataID}`
    )
    .then(() => console.log('Message envoyé dans le canal Discord.'))
    .catch(console.error);
}

function cleanupPDFOnceUploaded(pdfFilePath) {
  fs.unlink(pdfFilePath, (err) => {
    if (err) {
      console.warn(
        `Erreur lors de la suppression du fichier temporaire ${pdfFilePath}: ${err}`
      );
    } else {
      console.log(
        `Fichier temporaire et pdf supprimé: ${pdfFilePath}`
      );
    }
  });
}

// Fonction pour uploader le fichier PDF sur Google Drive
async function uploadToGoogleDrive(filePath) {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });

  const folderId = FOLDER_ID;

  const fileMetadata = {
    name: path.basename(filePath),
    parents: [folderId], // Ajoutez cette ligne pour spécifier le dossier
  };
  const media = {
    mimeType: 'application/pdf',
    body: fs.createReadStream(filePath),
  };

  drive.files.create(
    {
      resource: fileMetadata,
      media: media,
      fields: 'id',
    },
    (err, file) => {
      if (err) {
        console.error("Erreur lors de l'upload du fichier: ", err);
      } else {
        console.log(
          'Fichier uploadé avec succès, ID: ',
          file.data.id
        );
        cleanupPDFOnceUploaded(filePath);
        sendOKMessage(file.data.id);
      }
    }
  );
}

// Fonction pour autoriser l'accès à l'API Google Drive
async function authorize() {
  const { client_secret, client_id, redirect_uris } = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH)
  ).installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if we have previously stored a token.
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(
      JSON.parse(fs.readFileSync(TOKEN_PATH))
    );
    return oAuth2Client;
  }

  // Get new token
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    include_granted_scopes: true,
  });
  console._log(
    '[BYPASS] Authorize this app by visiting this url:',
    authUrl
  );
  console._log('[BYPASS]', authUrl);
  const { tokens } = await oAuth2Client.getToken(
    await askQuestion(
      '[BYPASS] Enter the god damn the code from that page here: '
    )
  );
  oAuth2Client.setCredentials(tokens);
  // Store the token to disk for later program executions
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console._log('[BYPASS] Token stored to', TOKEN_PATH);
  return oAuth2Client;
}

// Helper function to ask for user input
function askQuestion(query) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

function connexionToDiscord() {
  client.once('ready', async () => {
    console.log(`Connecté en tant que ${client.user.tag}`);

    try {
      const channel = await client.channels.fetch(
        DISCORD_TOKEN_CHANNEL_OFFERS
      );
      if (channel) {
        console.log(`Successfully fetched channel: ${channel.name}`);

        let credentials;
        try {
          credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
          console.log('Credentials loaded successfully.');
        } catch (err) {
          console.error('Error reading credentials.json:', err);
          process.exit(1);
        }

        if (!credentials.installed) {
          console.error('Invalid credentials.json format.');
          process.exit(1);
        }

        const { client_secret, client_id, redirect_uris } =
          credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(
          client_id,
          client_secret,
          redirect_uris[0]
        );

        function getAccessToken(oAuth2Client, callback) {
          const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
          });
          console._log(
            'Authorize this app by visiting this url:',
            authUrl
          );
          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(
            'Enter the code from that page here: ',
            (code) => {
              rl.close();
              oAuth2Client.getToken(code, (err, token) => {
                if (err) {
                  console.error('Error retrieving access token', err);
                  return;
                }
                oAuth2Client.setCredentials(token);
                fs.writeFile(
                  TOKEN_PATH,
                  JSON.stringify(token),
                  (err) => {
                    if (err) {
                      console.error('Error storing token', err);
                      return;
                    }
                    console.log('Token stored to', TOKEN_PATH);
                    callback(oAuth2Client, channel);
                  }
                );
              });
            }
          );
        }

        fs.readFile(TOKEN_PATH, (err, token) => {
          if (err) {
            console.log('No token found, obtaining new token...');
            return getAccessToken(oAuth2Client, initializeFiles);
          }
          oAuth2Client.setCredentials(JSON.parse(token));
          console.log('Token loaded successfully.');
          initializeFiles(oAuth2Client, channel);
        });
      } else {
        console.error(
          'Failed to fetch the channel. Channel is null.'
        );
      }
    } catch (error) {
      console.error('Error fetching channel:', error);
    }
  });

  // Connexion du client
  client.login(DISCORD_TOKEN).catch(console.error);
}

connexionToDiscord();

// Événement pour chaque nouveau message
client.on('messageCreate', async (message) => {
  if (
    message.channel.id === DISCORD_TOKEN_CHANNEL_TEXT_TO_PDF &&
    !message.content.includes('BOT : ')
  ) {
    // console.log("Nouveau message reçu:", message.content);
    await processDiscordMessage(message.content);
    console.log('Message pris en compte, va etre supprime');
    await message.delete();
  }
});

module.exports = generatePDF;
