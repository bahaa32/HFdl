const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const process = require('process');
const path = require('path');
const url = require('url');

console.log(`
    ░▒▓█▓▒░░▒▓█▓▒░▒▓████████▓▒░▒▓███████▓▒░░▒▓█▓▒░        
    ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░        
    ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░        
    ░▒▓████████▓▒░▒▓██████▓▒░ ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░        
    ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░        
    ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░        
    ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░      ░▒▓███████▓▒░░▒▓████████▓▒░ 
                                                          
                   By Zibri (2024)
                 Fixed version
`);

// Track visited folder URLs to prevent infinite loops and duplicates
const visitedUrls = new Set();

// Track file URLs to prevent duplicate downloads
const visitedFileUrls = new Set();

// Track active downloads
const activeDownloads = new Set();

// Max concurrent downloads
const MAX_CONCURRENT_DOWNLOADS = 24;

// Function to normalize URLs for better deduplication
function normalizeUrl(inputUrl) {
    // Parse URL
    const parsedUrl = new URL(inputUrl);
    
    // Remove trailing slash
    let path = parsedUrl.pathname;
    if (path.endsWith('/') && path.length > 1) {
        path = path.slice(0, -1);
    }
    
    // Reconstruct URL without trailing slash
    parsedUrl.pathname = path;
    
    // Convert to string and remove unnecessary query params 
    // (except those needed for repository navigation)
    const normalizedUrl = parsedUrl.toString();
    
    return normalizedUrl;
}

// Function to download a file using aria2c with progress bar
function downloadFile(downloadUrl, targetDir, filename) {
    return new Promise((resolve) => {
        console.log(`Starting download: ${path.join(targetDir, filename)}`);
        
        // Create aria2c process with parameters for progress display
        const aria2c = spawn('aria2c', [
            '-x16',                    // 16 connections
            '--allow-overwrite=true',  // Allow overwriting existing files
            '--summary-interval=1',    // Update summary frequently
            '--console-log-level=notice', // Show enough info but not too verbose
            '--show-console-readout=true', // Show progress bar
            '--human-readable=true',   // Human readable sizes
            '--download-result=full',  // Full download results
            '-d', targetDir,           // Download directory
            '-o', filename,            // Output filename
            downloadUrl                // URL to download
        ]);
        
        // Identifier for this download in the active set
        const downloadId = `${targetDir}/${filename}`;
        activeDownloads.add(downloadId);
        
        // Handle stdout (progress information)
        aria2c.stdout.on('data', (data) => {
            // Display raw aria2c output
            process.stdout.write(`[${filename}] ${data}`);
        });
        
        // Handle stderr
        aria2c.stderr.on('data', (data) => {
            console.error(`[${filename}] Error: ${data}`);
        });
        
        // Handle completion
        aria2c.on('close', (code) => {
            if (code === 0) {
                console.log(`\n[${filename}] Download completed successfully.`);
            } else {
                console.error(`\n[${filename}] Download process exited with code ${code}`);
            }
            
            // Remove from active downloads
            activeDownloads.delete(downloadId);
            resolve();
        });
    });
}

// Process the download queue with concurrency control
async function processDownloadQueue(queue) {
    console.log(`Processing download queue with ${queue.length} unique files...`);
    
    // Process all items in the queue
    while (queue.length > 0) {
        // Wait until we have a slot available
        if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }
        
        // Get the next item and start download
        const item = queue.shift();
        downloadFile(item.url, item.dir, item.filename)
            .catch(err => console.error(`Error downloading ${item.filename}: ${err.message}`));
    }
    
    // Wait for remaining downloads to complete
    while (activeDownloads.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Extract the relative path from a repo URL, skipping branch name
function extractRelativePath(repoUrl, baseUrl) {
    try {
        // Parse both URLs
        const parsedRepoUrl = new URL(repoUrl);
        const parsedBaseUrl = new URL(baseUrl);
        
        // Get the pathname parts
        const repoPathParts = parsedRepoUrl.pathname.split('/').filter(Boolean);
        const basePathParts = parsedBaseUrl.pathname.split('/').filter(Boolean);
        
        // Find the position of 'tree' in the URL path
        const treeIndex = repoPathParts.indexOf('tree');
        
        // If we found the tree part and there's a branch name after it
        if (treeIndex !== -1 && treeIndex + 1 < repoPathParts.length) {
            // Get everything after the branch name
            const pathAfterBranch = repoPathParts.slice(treeIndex + 2);
            return pathAfterBranch.join('/');
        }
        
        return '';
    } catch (e) {
        console.error(`Error extracting relative path: ${e.message}`);
        return '';
    }
}

// Function to recursively traverse and queue downloads
async function traverseAndQueue(repoUrl, initialRepo, relativePath, baseDir, dryRun, downloadQueue) {
    // Normalize URL for deduplication
    const normalizedUrl = normalizeUrl(repoUrl);
    
    // Skip if we've already visited this URL
    if (visitedUrls.has(normalizedUrl)) {
        return;
    }
    
    // Mark as visited
    visitedUrls.add(normalizedUrl);
    console.log(`\nExploring: ${repoUrl}`);
    
    try {
        const response = await axios.get(repoUrl);
        const $ = cheerio.load(response.data);
        
        // Process files (links with download=true)
        const fileLinks = $('a[href*="?download=true"]');
        fileLinks.each((index, link) => {
            const downloadUrl = new URL(link.attribs.href, repoUrl).href;
            const normalizedFileUrl = normalizeUrl(downloadUrl);
            
            // Skip if we've already queued this file
            if (visitedFileUrls.has(normalizedFileUrl)) {
                return;
            }
            
            visitedFileUrls.add(normalizedFileUrl);
            let filename = path.basename(downloadUrl).replace('?download=true', '');
            
            // Calculate the proper relative path by combining the passed relativePath
            // with any additional path extracted from the current URL
            let currentRelPath = relativePath;
            
            if (dryRun) {
                console.log(`File: ${currentRelPath}${currentRelPath ? '/' : ''}${filename}`);
                console.log(`URL: ${downloadUrl}`);
            } else {
                // Create directory structure if it doesn't exist
                const targetDir = path.join(baseDir, currentRelPath);
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }
                
                // Add to download queue
                downloadQueue.push({
                    url: downloadUrl,
                    dir: targetDir,
                    filename: filename
                });
            }
        });
        
        // IMPROVED FOLDER DETECTION
        // Look for all links that might be folders (multiple strategies)
        // 1. Look for SVG icons that indicate folders
        const folderSvgParents = $('a').filter(function() {
            // Find links with SVG that have a title attribute containing "folder" or "directory"
            const svgTitle = $(this).find('svg title').text().toLowerCase();
            return svgTitle.includes('folder') || svgTitle.includes('directory');
        });
        
        // 2. Also look for links with tree path in URL (standard pattern for repo folders)
        const treeLinks = $('a[href*="/tree/"]');
        
        // Combine both sets of potential folder links
        const allFolderLinks = new Set();
        
        folderSvgParents.each((_, link) => {
            if (link.attribs.href) allFolderLinks.add(link);
        });
        
        treeLinks.each((_, link) => {
            if (link.attribs.href) allFolderLinks.add(link);
        });
        
        // Process each folder link
        for (const link of allFolderLinks) {
            const href = link.attribs.href;
            
            // Skip links that are not repository folders
            if (!href || 
                href.includes('?download=true') || 
                href.includes('/blob/') || 
                href.includes('/commit/') || 
                href.includes('/discussions/')) {
                continue;
            }
            
            // Check if it's a subfolder in the current repository
            if (href.includes('/tree/')) {
                const folderUrl = new URL(href, repoUrl).href;
                
                // Extract the path from the URL directly
                const folderPath = extractRelativePath(folderUrl, initialRepo);
                
                // Skip if can't determine folder path
                if (folderPath === undefined) {
                    continue;
                }
                
                // Recursively traverse the subfolder with the full path
                await traverseAndQueue(folderUrl, initialRepo, folderPath, baseDir, dryRun, downloadQueue);
            }
        }
    } catch (error) {
        console.error(`Error processing ${repoUrl}: ${error.message}`);
    }
}

(async function() {
    if (process.argv.length < 3) {
        console.error('Usage: node hfdl.js <HFUser/repo> [directory]');
        console.error('Example: node hfdl.js bartowski/dolphin-2.8-mistral-7b-v02-GGUF');
        process.exit(1);
    }

    let repoPath = process.argv[2]; // Repository path from command line
    const directory = process.argv[3]; // Directory from command line
    const dryRun = !directory; // Dry run if directory is not specified
    
    // Create download queue
    const downloadQueue = [];

    // Check if aria2c is installed
    try {
        const ariaCheck = spawn('aria2c', ['--version']);
        ariaCheck.on('error', () => {
            console.error('aria2c is not installed. Please install it before running this script.');
            process.exit(1);
        });
    } catch (error) {
        console.error('aria2c is not installed. Please install it before running this script.');
        process.exit(1);
    }

    // Format the repository URL
    let repoUrl;
    if (!repoPath.startsWith('https://huggingface.co/')) {
        repoUrl = `https://huggingface.co/${repoPath}/tree/main/`;
    } else {
        repoUrl = repoPath;
        if (!repoUrl.includes('/tree/')) {
            repoUrl = `${repoUrl}/tree/main/`;
        }
    }

    // Start the recursive traversal and queue downloads
    console.log('Building download queue...');
    await traverseAndQueue(repoUrl, repoUrl, '', directory, dryRun, downloadQueue);

    if (dryRun) {
        console.log('\nTo download the files, a directory must be specified.');
        console.log(`Found ${downloadQueue.length} unique files that would be downloaded.`);
    } else {
        console.log(`\nFound ${downloadQueue.length} unique files to download.`);
        console.log(`Starting downloads with max ${MAX_CONCURRENT_DOWNLOADS} concurrent downloads.`);
        
        // Process the download queue
        await processDownloadQueue(downloadQueue);
        
        console.log('\nAll downloads completed!');
    }
})();
