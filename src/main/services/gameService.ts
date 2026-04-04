import { join } from 'path'
import { promises as fs, readFileSync } from 'fs'
import { execa } from 'execa'
import { app, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import dependencyService from './dependencyService'
import mirrorService from './mirrorService'
import { GameInfo, ServiceStatus, GamesAPI, BlacklistEntry } from '@shared/types'
import EventEmitter from 'events'
import { typedWebContentsSend } from '@shared/ipc-utils'
import yts from 'yt-search'
import SevenZip from 'node-7z'

interface VrpConfig {
  baseUri: string
  password: string
  lastSync?: Date
}

const INTERNAL_BLACKLIST_GAMES = ['com.oculus.MiramarSetupRetail']

class GameService extends EventEmitter implements GamesAPI {
  private dataPath: string
  private configPath: string
  private gameListPath: string
  private metaPath: string
  private blacklistGamesPath: string
  private customBlacklistPath: string
  private vrpConfig: VrpConfig | null = null
  private games: GameInfo[] = []
  private blacklistGames: string[] = []
  private customBlacklistGames: BlacklistEntry[] = []
  private status: ServiceStatus = 'NOT_INITIALIZED'
  private videoIdCache: Map<string, string | null> = new Map()
  constructor() {
    super()
    this.dataPath = join(app.getPath('userData'), 'vrp-data')
    this.configPath = join(this.dataPath, 'vrp-config.json')
    this.gameListPath = join(this.dataPath, 'VRP-GameList.txt')
    this.metaPath = join(this.dataPath, '.meta')
    this.blacklistGamesPath = join(this.metaPath, 'nouns', 'blacklist.txt')
    this.customBlacklistPath = join(app.getPath('userData'), 'custom-blacklist.json')
  }

  async initialize(force?: boolean): Promise<ServiceStatus> {
    if (this.status === 'INITIALIZING') {
      console.log('GameService already initializing, skipping.')
      return 'INITIALIZING'
    }
    if (!force && this.status === 'INITIALIZED') {
      console.log('GameService already initialized, skipping.')
      return 'INITIALIZED'
    }
    this.status = 'INITIALIZING'
    console.log('Initializing GameService...')
    await fs.mkdir(this.dataPath, { recursive: true })
    try {
      // Load configuration if exists
      await this.loadConfig()

      // Check if we need to sync data
      // const needsSync = await this.needsSync()

      // if (needsSync) {
      //   console.log('Syncing game data...')
      //   await this.syncGameData()
      // } else {
      console.log('Using cached game data...')
      await this.loadGameList()
      await this.loadBlacklistGames()
      await this.loadCustomBlacklistGames()
      //}
    } catch (error) {
      console.error('Error initializing game service:', error)
      this.status = 'ERROR'
      return 'ERROR'
    } finally {
      this.status = 'INITIALIZED'
    }
    return 'INITIALIZED'
  }

  private async loadConfig(): Promise<void> {
    try {
      const exists = await fileExists(this.configPath)
      if (exists) {
        const data = await fs.readFile(this.configPath, 'utf-8')
        this.vrpConfig = JSON.parse(data)

        // Convert lastSync string to Date object if it exists
        if (this.vrpConfig?.lastSync) {
          this.vrpConfig.lastSync = new Date(this.vrpConfig.lastSync)
        }

        console.log(
          'Loaded config from disk - baseUri:',
          !!this.vrpConfig?.baseUri,
          'password:',
          !!this.vrpConfig?.password
        )
      } else {
        console.log('No config file found at', this.configPath)
        await this.fetchVrpPublicInfo()
      }
    } catch (error) {
      console.error('Error loading configuration:', error)
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      if (this.vrpConfig) {
        console.log(
          'Saving config to disk - baseUri:',
          !!this.vrpConfig.baseUri,
          'password:',
          !!this.vrpConfig.password
        )
        await fs.writeFile(this.configPath, JSON.stringify(this.vrpConfig), 'utf-8')
      }
    } catch (error) {
      console.error('Error saving configuration:', error)
    }
  }

  // private async needsSync(): Promise<boolean> {
  //   try {
  //     // Check if game list file exists
  //     const gameListExists = await fileExists(this.gameListPath)
  //     if (!gameListExists) {
  //       return true
  //     }

  //     // If no last sync time or it's been more than 24 hours, sync again
  //     if (!this.vrpConfig?.lastSync) {
  //       return true
  //     }

  //     const lastSync = this.vrpConfig.lastSync
  //     const ONE_DAY = 24 * 60 * 60 * 1000 // 24 hours in milliseconds
  //     return Date.now() - lastSync.getTime() > ONE_DAY
  //   } catch (error) {
  //     console.error('Error checking if sync is needed:', error)
  //     return true // Default to sync on error
  //   }
  // }

  async syncGameData(): Promise<void> {
    try {
      // First fetch the VRP public info
      await this.fetchVrpPublicInfo()

      if (!this.vrpConfig?.baseUri) {
        throw new Error('Failed to get baseUri from VRP public info')
      }

      if (!this.vrpConfig?.password) {
        throw new Error('Failed to get password from VRP public info')
      }

      console.log(
        'Starting sync with valid config - baseUri:',
        !!this.vrpConfig.baseUri,
        'password:',
        !!this.vrpConfig.password
      )

      // Download meta.7z using rclone
      const metaArchive = join(this.dataPath, 'meta.7z')
      await this.downloadMetaArchive(metaArchive)

      // Extract the archive
      await this.extractMetaArchive(metaArchive)

      // Load the game list
      await this.loadGameList()
      await this.loadBlacklistGames()
      await this.loadCustomBlacklistGames()

      // Update last sync time
      if (this.vrpConfig) {
        this.vrpConfig.lastSync = new Date()
        await this.saveConfig()
      }
    } catch (error) {
      console.error('Error syncing game data:', error)
      throw error
    }
  }

  private async fetchVrpPublicInfo(): Promise<void> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)

      const response = await fetch('https://pastebin.com/raw/KchrQnFY', {
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      this.vrpConfig = data as VrpConfig

      console.log('VRP Config loaded - baseUri:', !!this.vrpConfig?.baseUri)

      await this.saveConfig()
    } catch (error) {
      console.error('Error fetching VRP public info:', error)
      throw error
    }
  }

  private async downloadMetaArchive(destination: string): Promise<void> {
    try {
      if (!this.vrpConfig?.baseUri) {
        throw new Error('baseUri not found in config')
      }

      // Check if there's an active mirror to use
      const activeMirror = await mirrorService.getActiveMirror()
      const baseUri = this.vrpConfig.baseUri
      let rcloneArgs: string[]

      console.log(`Downloading meta.7z from ${baseUri}...`)

      // Get the appropriate rclone path based on platform
      const rclonePath = dependencyService.getRclonePath()

      // Get the main window to send progress updates
      const mainWindow = BrowserWindow.getAllWindows()[0]

      if (activeMirror) {
        console.log(`Using active mirror: ${activeMirror.name}`)

        // Get the config file path and remote name
        const configFilePath = mirrorService.getActiveMirrorConfigPath()
        const remoteName = mirrorService.getActiveMirrorRemoteName()

        if (!configFilePath || !remoteName) {
          console.warn('Failed to get mirror config file path, falling back to public endpoint')
          // Fall back to public endpoint logic below
        } else {
          try {
            // Use mirror with direct config file reference
            rcloneArgs = [
              'sync',
              `${remoteName}:/Quest Games/meta.7z`,
              destination,
              '--config',
              configFilePath,
              '--tpslimit',
              '1.0',
              '--tpslimit-burst',
              '3',
              '--no-check-certificate',
              '--progress'
            ]

            // Execute rclone using execa with progress reporting
            const rcloneProcess = execa(rclonePath, rcloneArgs, {
              stdio: ['ignore', 'pipe', 'pipe']
            })

            // Process stdout for progress information
            if (rcloneProcess.stdout) {
              rcloneProcess.stdout.on('data', (data) => {
                const output = data.toString()

                // Try to parse progress information from rclone output
                const progressPattern = /Transferred:.*?(\d+)%/
                const match = output.match(progressPattern)

                if (match && match[1]) {
                  const progressPercentage = parseInt(match[1], 10)

                  // Send progress to renderer process if we have a valid window
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    typedWebContentsSend.send(mainWindow, 'games:download-progress', {
                      packageName: 'meta',
                      stage: 'download',
                      progress: progressPercentage
                    })
                  }
                }
              })
            }

            // Process stderr for errors
            if (rcloneProcess.stderr) {
              rcloneProcess.stderr.on('data', (data) => {
                console.error('Rclone error:', data.toString())
              })
            }

            // Wait for process to complete
            const result = await rcloneProcess

            if (result.exitCode !== 0) {
              console.error(
                `Mirror download failed with exit code ${result.exitCode}, falling back to public endpoint`
              )
              throw new Error(`Mirror download failed: ${result.stderr}`)
            }

            console.log('Mirror download complete')

            // Send 100% progress on completion
            if (mainWindow && !mainWindow.isDestroyed()) {
              typedWebContentsSend.send(mainWindow, 'games:download-progress', {
                packageName: 'meta',
                stage: 'download',
                progress: 100
              })
            }
            return // Success with mirror
          } catch (error) {
            console.error('Failed to use mirror config file:', error)
            // Fall through to public endpoint logic
          }
        }
      }

      // Fall back to public endpoint if no mirror or mirror failed
      console.log('Using public endpoint for meta.7z download')

      // Get the appropriate null config path based on platform
      const nullConfigPath = process.platform === 'win32' ? 'NUL' : '/dev/null'

      // Execute rclone using execa with progress reporting
      const rcloneProcess = execa(
        rclonePath,
        [
          'sync',
          `:http:/meta.7z`,
          destination,
          '--config',
          nullConfigPath,
          '--http-url',
          baseUri,
          '--tpslimit',
          '1.0',
          '--tpslimit-burst',
          '3',
          '--no-check-certificate',
          '--progress'
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      // Process stdout for progress information
      if (rcloneProcess.stdout) {
        rcloneProcess.stdout.on('data', (data) => {
          const output = data.toString()

          // Try to parse progress information from rclone output
          // Example pattern: "Transferred: 5.584M / 10.000 MBytes, 56%, 1.000 MBytes/s, ETA 0s"
          const progressPattern = /Transferred:.*?(\d+)%/
          const match = output.match(progressPattern)

          if (match && match[1]) {
            const progressPercentage = parseInt(match[1], 10)

            // Send progress to renderer process if we have a valid window
            if (mainWindow && !mainWindow.isDestroyed()) {
              typedWebContentsSend.send(mainWindow, 'games:download-progress', {
                packageName: 'meta',
                stage: 'download',
                progress: progressPercentage
              })
            }
          }
        })
      }

      // Process stderr for errors
      if (rcloneProcess.stderr) {
        rcloneProcess.stderr.on('data', (data) => {
          console.error('Rclone error:', data.toString())
        })
      }

      // Wait for process to complete
      const result = await rcloneProcess

      if (result.exitCode !== 0) {
        throw new Error(`Rclone failed with exit code ${result.exitCode}: ${result.stderr}`)
      }

      console.log('Download complete')

      // Send 100% progress on completion
      if (mainWindow && !mainWindow.isDestroyed()) {
        typedWebContentsSend.send(mainWindow, 'games:download-progress', {
          packageName: 'meta',
          stage: 'download',
          progress: 100
        })
      }
    } catch (error) {
      console.error('Error downloading meta archive:', error)
      throw error
    }
  }

  private async extractMetaArchive(archive: string): Promise<void> {
    try {
      console.log(`Extracting ${archive} to ${this.dataPath}...`)

      if (!this.vrpConfig?.password) {
        throw new Error('Password not found in vrpConfig')
      }

      try {
        // Base64 decode the password
        const decodedPassword = Buffer.from(this.vrpConfig.password, 'base64').toString('utf-8')
        console.log('Successfully decoded password for extraction')
        console.log('Using node-7z to extract archive start')

        const mainWindow = BrowserWindow.getAllWindows()[0]

        await new Promise<void>((resolve, reject) => {
          const myStream = SevenZip.extractFull(archive, this.dataPath, {
            $bin: dependencyService.get7zPath(),
            password: decodedPassword,
            $progress: true
          })

          myStream.on('progress', function (progress) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              typedWebContentsSend.send(mainWindow, 'games:download-progress', {
                packageName: 'meta',
                stage: 'extract',
                progress: progress.percent
              })
            }
          })

          myStream.on('end', function () {
            console.log('Extraction complete')
            resolve() // Resolve the Promise when extraction is complete
          })

          myStream.on('error', function (error) {
            console.error('Extraction error:', error)
            reject(error) // Reject the Promise if there's an error
          })
        })

        console.log('Extraction complete')

        // Send 100% progress on completion
        if (mainWindow && !mainWindow.isDestroyed()) {
          typedWebContentsSend.send(mainWindow, 'games:download-progress', {
            packageName: 'meta',
            stage: 'extract',
            progress: 100
          })
        }
      } catch (decodeError: unknown) {
        console.error('Error decoding or using password, you should probably open an issue for us to update it:', decodeError)
        if (decodeError instanceof Error) {
          throw new Error(`Failed to use password, you should probably open an issue for us to update it: ${decodeError.message}`)
        } else {
          throw new Error(`Failed to use password, you should probably open an issue for us to update it: ${String(decodeError)}`)
        }
      }
    } catch (error) {
      console.error('Error extracting meta archive:', error)
      throw error
    }
  }

  private async loadGameList(): Promise<void> {
    try {
      const exists = await fileExists(this.gameListPath)
      if (!exists) {
        console.error('Game list file not found')
        return
      }

      const data = await fs.readFile(this.gameListPath, 'utf-8')
      this.parseGameList(data)
    } catch (error) {
      console.error('Error loading game list:', error)
    }
  }

  private async loadBlacklistGames(): Promise<void> {
    const exists = await fileExists(this.blacklistGamesPath)
    if (!exists) {
      console.error('Blacklist games file not found')
      return
    }
    const data = await fs.readFile(this.blacklistGamesPath, 'utf-8')
    this.blacklistGames = data.split('\n')
    console.log(`Loaded ${this.blacklistGames.length} games from blacklist`)
  }

  private async loadCustomBlacklistGames(): Promise<void> {
    try {
      if (existsSync(this.customBlacklistPath)) {
        const data = await fs.readFile(this.customBlacklistPath, 'utf-8')
        try {
          this.customBlacklistGames = JSON.parse(data)
          console.log(`Loaded ${this.customBlacklistGames.length} games from custom blacklist`)
        } catch (parseError) {
          console.error('Error parsing custom blacklist JSON:', parseError)
          this.customBlacklistGames = []
        }
      } else {
        console.log('No custom blacklist file found, starting with empty list')
        this.customBlacklistGames = []
      }
    } catch (error) {
      console.error('Error loading custom blacklist games:', error)
      this.customBlacklistGames = []
    }
  }

  private async saveCustomBlacklistGames(): Promise<void> {
    try {
      await fs.writeFile(
        this.customBlacklistPath,
        JSON.stringify(this.customBlacklistGames),
        'utf-8'
      )
      console.log(`Saved ${this.customBlacklistGames.length} games to custom blacklist`)
    } catch (error) {
      console.error('Error saving custom blacklist games:', error)
    }
  }

  private parseGameList(data: string): void {
    const lines = data.split('\n')
    const games: GameInfo[] = []

    // Skip the header line
    const headerLine = lines[0]
    if (!headerLine || !headerLine.includes(';')) {
      console.error('Invalid header format in game list')
      return
    }
    console.log('Header Line:', headerLine)

    // Extract column names from header
    const columns = headerLine.split(';').map((col) => col.trim())
    console.log('Parsed Columns:', columns)

    const gameNameIndex = columns.indexOf('Game Name')
    const packageNameIndex = columns.indexOf('Package Name')
    const versionCodeIndex = columns.indexOf('Version Code')
    const sizeIndex = columns.indexOf('Size (MB)')
    const lastUpdatedIndex = columns.indexOf('Last Updated')
    const releaseNameIndex = columns.indexOf('Release Name')
    const downloadsIndex = columns.indexOf('Downloads')

    // Process data lines (skip header)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      try {
        const parts = line.split(';')

        // Skip if we don't have all columns
        if (parts.length < columns.length) {
          console.warn(
            `Skipping incomplete game entry (expected ${columns.length}, got ${parts.length}): ${line}`
          )
          continue
        }

        // Get values from the correct column positions
        const gameName = gameNameIndex >= 0 ? parts[gameNameIndex].trim() : 'Unknown'
        const packageName = packageNameIndex >= 0 ? parts[packageNameIndex].trim() : ''
        const versionCode = versionCodeIndex >= 0 ? parts[versionCodeIndex].trim() : ''
        const size = sizeIndex >= 0 ? `${parts[sizeIndex].trim()} MB` : ''
        const lastUpdated = lastUpdatedIndex >= 0 ? parts[lastUpdatedIndex].trim() : ''
        const releaseName = releaseNameIndex >= 0 ? parts[releaseNameIndex].trim() : ''
        const downloads = downloadsIndex >= 0 ? parts[downloadsIndex].trim() : ''

        if (gameName === 'Unknown') {
          console.warn(
            `Game name is Unknown for line: ${line}. gameNameIndex: ${gameNameIndex}, parts[gameNameIndex]: ${parts[gameNameIndex]}`
          )
        }

        // Skip if we don't have essential information
        if (!gameName || !packageName) {
          console.warn(`Skipping game with missing name or package: ${line}`)
          continue
        }

        // Generate thumbnail path if the package name is available
        const thumbnailPath = packageName
          ? join(this.metaPath, 'thumbnails', `${packageName}.jpg`)
          : ''

        const thumbnailExists = existsSync(thumbnailPath)

        // Generate note path based on release name
        const notePath = releaseName ? join(this.metaPath, 'notes', `${releaseName}.txt`) : ''

        const gameInfo: GameInfo = {
          id: packageName || gameName.replace(/\s+/g, '-').toLowerCase(),
          name: gameName,
          packageName,
          version: versionCode,
          size,
          lastUpdated,
          releaseName,
          downloads: parseFloat(downloads) || 0,
          thumbnailPath: thumbnailExists ? thumbnailPath : '',
          notePath,
          isInstalled: false
        }

        games.push(gameInfo)
      } catch (error) {
        console.error('Error parsing game line:', line, error)
      }
    }

    this.games = games
    console.log(`Loaded ${games.length} games`)
  }

  async forceSync(): Promise<GameInfo[]> {
    await this.syncGameData()
    return this.games
  }

  getGames(): Promise<GameInfo[]> {
    return Promise.resolve(this.games)
  }

  getBlacklistGames(): Promise<BlacklistEntry[]> {
    return Promise.resolve(this.customBlacklistGames)
  }

  getLastSyncTime(): Promise<Date | null> {
    return Promise.resolve(this.vrpConfig?.lastSync || null)
  }

  // Added method to expose VRP config needed by DownloadService
  getVrpConfig(): Promise<{ baseUri?: string; password?: string } | null> {
    if (!this.vrpConfig) {
      console.warn('Attempted to get VRP config before it was loaded.')
      return Promise.resolve(null)
    }
    // Return only necessary parts, don't expose lastSync etc.
    return Promise.resolve({
      baseUri: this.vrpConfig.baseUri,
      password: this.vrpConfig.password
    })
  }

  getNote(releaseName: string): Promise<string> {
    const notePath = join(this.metaPath, 'notes', `${releaseName}.txt`)
    const noteExists = existsSync(notePath)
    return Promise.resolve(noteExists ? readFileSync(notePath, 'utf-8') : '')
  }

  async getTrailerVideoId(gameName: string): Promise<string | null> {
    // Check if the video ID is in the cache
    if (this.videoIdCache.has(gameName)) {
      return this.videoIdCache.get(gameName) || null
    }

    const searchQuery = `${gameName} quest vr trailer`
    const searchResults = await yts({
      query: searchQuery,
      pages: 1
    })
    if (!searchResults.videos || searchResults.videos.length === 0) {
      // Cache the null result to avoid repeated searches
      this.videoIdCache.set(gameName, null)
      return null
    }

    const cleanGameName = (name: string): string =>
      // remove all non-alphanumeric characters and convert to lowercase
      name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()

    // only use videos that have the game name in the title
    const video = searchResults.videos.find((video) =>
      cleanGameName(video.title).includes(cleanGameName(gameName))
    )

    const videoId = video ? video.videoId : null
    // Store result in cache (even if null)
    this.videoIdCache.set(gameName, videoId)

    return videoId
  }

  async addToBlacklist(packageName: string, version: number | 'any' = 'any'): Promise<boolean> {
    // Check if game is already in original blacklist
    if (
      this.blacklistGames.includes(packageName) ||
      INTERNAL_BLACKLIST_GAMES.includes(packageName)
    ) {
      return false
    }

    // Check if game is already in custom blacklist with same or higher version
    const existingEntry = this.customBlacklistGames.find(
      (entry) => entry.packageName === packageName
    )
    if (existingEntry) {
      // If existing entry has version 'any', it covers all versions already
      if (existingEntry.version === 'any') {
        return false
      }

      // If we're adding 'any' version or a higher version number, update the entry
      if (
        version === 'any' ||
        (typeof existingEntry.version === 'number' &&
          typeof version === 'number' &&
          version > existingEntry.version)
      ) {
        existingEntry.version = version
        await this.saveCustomBlacklistGames()
        return true
      }

      // Don't add if new version is equal or lower than existing version
      if (
        typeof existingEntry.version === 'number' &&
        typeof version === 'number' &&
        version <= existingEntry.version
      ) {
        return false
      }
    }

    // Add to custom blacklist
    this.customBlacklistGames.push({ packageName, version })

    // Save updated custom blacklist
    await this.saveCustomBlacklistGames()

    return true
  }

  async removeFromBlacklist(packageName: string): Promise<boolean> {
    // Check if the game is in the internal blacklist (can't be removed)
    if (INTERNAL_BLACKLIST_GAMES.includes(packageName)) {
      return false
    }

    // Check if game is in custom blacklist
    const index = this.customBlacklistGames.findIndex((entry) => entry.packageName === packageName)
    if (index === -1) {
      return false
    }

    // Remove from custom blacklist
    this.customBlacklistGames.splice(index, 1)

    // Save updated custom blacklist
    await this.saveCustomBlacklistGames()

    return true
  }

  isGameBlacklisted(packageName: string, version?: number): boolean {
    // Check internal and original blacklist (these block all versions)
    if (
      INTERNAL_BLACKLIST_GAMES.includes(packageName) ||
      this.blacklistGames.includes(packageName)
    ) {
      return true
    }

    // Check custom blacklist with version comparison
    const entry = this.customBlacklistGames.find((entry) => entry.packageName === packageName)
    if (!entry) {
      return false
    }

    // If entry version is 'any', it blocks all versions
    if (entry.version === 'any') {
      return true
    }

    // If no specific version provided for checking, consider it blacklisted
    if (version === undefined) {
      return true
    }

    // Compare versions - only blacklisted if the version we're checking is less than or equal to blacklisted version
    return typeof entry.version === 'number' && version <= entry.version
  }
}

// Helper function to check if a file exists
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export default new GameService()
