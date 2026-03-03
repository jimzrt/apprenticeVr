import { app } from 'electron'
import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { Dirent, existsSync, promises as fs } from 'fs'
import settingsService from './settingsService'
import { LocalLibraryEntry, LocalLibraryIndex } from '@shared/types'

const MAX_SCAN_DEPTH = 4
const POLL_INTERVAL_MS = 30000

class LocalLibraryService extends EventEmitter {
  private readonly indexPath: string
  private index: LocalLibraryIndex
  private initialized = false
  private scanRootPath: string
  private scanTimeout: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private scanInProgress = false
  private pendingScan = false

  constructor() {
    super()
    this.indexPath = join(app.getPath('userData'), 'local-library-index.json')
    this.scanRootPath = settingsService.getDownloadPath()
    this.index = {
      rootPath: this.scanRootPath,
      generatedAt: Date.now(),
      entries: []
    }

    settingsService.on('download-path-changed', (path: string) => {
      this.scanRootPath = path
      this.scheduleRescan(250)
    })
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return

    await this.loadIndexFromDisk()
    this.scanRootPath = settingsService.getDownloadPath()

    // Ensure root path is always aligned with current setting.
    if (this.index.rootPath !== this.scanRootPath) {
      this.index = {
        rootPath: this.scanRootPath,
        generatedAt: Date.now(),
        entries: []
      }
      await this.saveIndexToDisk()
    }

    await this.rescan()

    this.pollTimer = setInterval(() => {
      this.scheduleRescan(0)
    }, POLL_INTERVAL_MS)

    this.initialized = true
    console.log('[LocalLibrary] Service initialized.')
  }

  public async shutdown(): Promise<void> {
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout)
      this.scanTimeout = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.initialized = false
  }

  public getIndex(): LocalLibraryIndex {
    return this.index
  }

  public async rescan(): Promise<LocalLibraryIndex> {
    if (this.scanInProgress) {
      this.pendingScan = true
      return this.index
    }

    this.scanInProgress = true

    try {
      const nextIndex = await this.buildIndex(this.scanRootPath)
      const changed = this.isIndexChanged(this.index, nextIndex)

      this.index = nextIndex

      if (changed) {
        await this.saveIndexToDisk()
        this.emit('updated', this.index)
        console.log(
          `[LocalLibrary] Index updated. ${this.index.entries.length} local entry(ies) at ${this.index.rootPath}`
        )
      }

      return this.index
    } finally {
      this.scanInProgress = false
      if (this.pendingScan) {
        this.pendingScan = false
        this.scheduleRescan(100)
      }
    }
  }

  private scheduleRescan(delayMs: number): void {
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout)
    }
    this.scanTimeout = setTimeout(() => {
      this.scanTimeout = null
      this.rescan().catch((error) => {
        console.error('[LocalLibrary] Scheduled rescan failed:', error)
      })
    }, delayMs)
  }

  private async loadIndexFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.indexPath)) return
      const content = await fs.readFile(this.indexPath, 'utf-8')
      const parsed = JSON.parse(content) as LocalLibraryIndex
      if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.rootPath !== 'string') return
      this.index = parsed
    } catch (error) {
      console.warn('[LocalLibrary] Failed to load index from disk:', error)
    }
  }

  private async saveIndexToDisk(): Promise<void> {
    try {
      await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
    } catch (error) {
      console.warn('[LocalLibrary] Failed to save index to disk:', error)
    }
  }

  private isIndexChanged(previous: LocalLibraryIndex, next: LocalLibraryIndex): boolean {
    if (previous.rootPath !== next.rootPath) return true

    const normalize = (index: LocalLibraryIndex): string =>
      JSON.stringify({
        rootPath: index.rootPath,
        entries: index.entries.map((entry) => ({
          id: entry.id,
          releaseName: entry.releaseName,
          path: entry.path,
          source: entry.source,
          apkCount: entry.apkCount,
          hasInstallScript: entry.hasInstallScript,
          packageNames: [...entry.packageNames].sort()
        }))
      })

    return normalize(previous) !== normalize(next)
  }

  private async buildIndex(rootPath: string): Promise<LocalLibraryIndex> {
    const generatedAt = Date.now()
    const entries: LocalLibraryEntry[] = []

    if (!rootPath || !existsSync(rootPath)) {
      return { rootPath, generatedAt, entries }
    }

    let topLevelEntries: Dirent[] = []
    try {
      topLevelEntries = await fs.readdir(rootPath, { withFileTypes: true })
    } catch (error) {
      console.warn(`[LocalLibrary] Failed to read root path "${rootPath}":`, error)
      return { rootPath, generatedAt, entries }
    }

    for (const topEntry of topLevelEntries) {
      const fullPath = join(rootPath, topEntry.name)

      if (topEntry.isFile() && topEntry.name.toLowerCase().endsWith('.apk')) {
        const packageName = this.parsePackageNameFromApk(topEntry.name)
        entries.push({
          id: fullPath,
          releaseName: basename(topEntry.name, '.apk'),
          path: fullPath,
          source: 'apk-file',
          apkCount: 1,
          hasInstallScript: false,
          packageNames: packageName ? [packageName] : [],
          lastSeen: generatedAt
        })
        continue
      }

      if (!topEntry.isDirectory()) continue

      const folderScan = await this.scanDirectoryForInstallables(fullPath, 0)
      if (folderScan.apkFiles.length === 0 && !folderScan.hasInstallScript) continue

      const packageNames = Array.from(
        new Set(
          folderScan.apkFiles
            .map((apkPath) => this.parsePackageNameFromApk(apkPath))
            .filter((name): name is string => Boolean(name))
        )
      ).sort()

      entries.push({
        id: fullPath,
        releaseName: topEntry.name,
        path: fullPath,
        source: 'folder',
        apkCount: folderScan.apkFiles.length,
        hasInstallScript: folderScan.hasInstallScript,
        packageNames,
        lastSeen: generatedAt
      })
    }

    entries.sort((a, b) => a.releaseName.localeCompare(b.releaseName))
    return { rootPath, generatedAt, entries }
  }

  private async scanDirectoryForInstallables(
    dirPath: string,
    depth: number
  ): Promise<{ apkFiles: string[]; hasInstallScript: boolean }> {
    const apkFiles: string[] = []
    let hasInstallScript = false

    let dirEntries: Dirent[] = []
    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return { apkFiles, hasInstallScript }
    }

    for (const entry of dirEntries) {
      const entryPath = join(dirPath, entry.name)
      const lowerName = entry.name.toLowerCase()

      if (entry.isFile()) {
        if (lowerName.endsWith('.apk')) apkFiles.push(entryPath)
        if (lowerName === 'install.txt') hasInstallScript = true
        continue
      }

      if (entry.isDirectory() && depth < MAX_SCAN_DEPTH) {
        const nested = await this.scanDirectoryForInstallables(entryPath, depth + 1)
        if (nested.apkFiles.length > 0) apkFiles.push(...nested.apkFiles)
        if (nested.hasInstallScript) hasInstallScript = true
      }
    }

    return { apkFiles, hasInstallScript }
  }

  private parsePackageNameFromApk(apkPathOrFileName: string): string | null {
    const fileName = basename(apkPathOrFileName)
    if (!fileName.toLowerCase().endsWith('.apk')) return null

    const baseName = basename(fileName, '.apk')
    // Typical Android package format, tolerant of uppercase segments seen in some releases.
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(baseName)) {
      return null
    }

    return baseName
  }
}

export default new LocalLibraryService()
