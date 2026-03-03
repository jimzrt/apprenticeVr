/**
 * Shared type definitions for both main and renderer processes
 */

import { BrowserWindow } from 'electron'

type Modify<T, R> = Omit<T, keyof R> & R

// Device types
export interface DeviceInfo {
  id: string
  type: 'emulator' | 'device' | 'offline' | 'unauthorized' | 'unknown' | 'wifi-bookmark'
  model: string | null
  isQuestDevice: boolean
  batteryLevel: number | null
  storageTotal: string | null
  storageFree: string | null
  friendlyModelName: string | null
  ipAddress: string | null
  // Ping status for WiFi devices
  pingStatus?: 'checking' | 'reachable' | 'unreachable' | 'unknown'
  pingResponseTime?: number // in milliseconds
}

export interface WiFiBookmark {
  id: string
  name: string
  ipAddress: string
  port: number
  dateAdded: Date
  lastConnected?: Date
}

// Extended device type that includes bookmark data
export interface DeviceWithBookmark extends DeviceInfo {
  bookmarkData: WiFiBookmark
}

// Union type for devices that may or may not have bookmark data
export type ExtendedDeviceInfo = DeviceInfo | DeviceWithBookmark

// Type guard to check if a device has bookmark data
export function hasBookmarkData(device: ExtendedDeviceInfo): device is DeviceWithBookmark {
  return 'bookmarkData' in device && device.bookmarkData !== undefined
}

// Type guard to check if a device is a WiFi bookmark
export function isWiFiBookmark(device: ExtendedDeviceInfo): boolean {
  return device.type === 'wifi-bookmark'
}

// Type guard to check if a device is a TCP device (has IP:PORT format)
export function isTcpDevice(device: ExtendedDeviceInfo): boolean {
  return device.id.includes(':')
}

export interface PackageInfo {
  packageName: string
  versionCode: number
  // More metadata fields will be added in the future
}

// Game types
export interface GameInfo {
  id: string
  name: string
  packageName: string
  version: string
  size: string
  lastUpdated: string
  releaseName: string
  downloads: number
  thumbnailPath: string
  notePath: string
  isInstalled: boolean
  deviceVersionCode?: number
  hasUpdate?: boolean
}

export interface UploadCandidate {
  packageName: string
  gameName: string
  versionCode: number
  reason: 'missing' | 'newer'
  storeVersion?: string
}

// Upload types
export interface UploadPreparationProgress {
  packageName: string
  stage: string
  progress: number
}

export type UploadStatus =
  | 'Queued'
  | 'Preparing'
  | 'Uploading'
  | 'Completed'
  | 'Error'
  | 'Cancelled'

export interface UploadItem {
  packageName: string
  gameName: string
  versionCode: number
  deviceId: string
  status: UploadStatus
  progress: number
  stage?: string
  error?: string
  addedDate: number
  zipPath?: string
}

// Download types
export type DownloadStatus =
  | 'Queued'
  | 'Downloading'
  | 'Paused'
  | 'Completed'
  | 'Error'
  | 'Cancelled'
  | 'Extracting'
  | 'Installing'
  | 'InstallError'

export interface DownloadItem {
  gameId: string
  releaseName: string
  gameName: string
  packageName: string
  status: DownloadStatus
  progress: number
  error?: string
  downloadPath: string
  pid?: number
  addedDate: number
  thumbnailPath?: string
  speed?: string
  eta?: string
  extractProgress?: number
  size?: string
  // If true, download/extract completes but auto-install step is skipped.
  skipInstall?: boolean
}

export interface DownloadAddOptions {
  skipInstall?: boolean
  forceRequeueCompleted?: boolean
}

export interface DownloadProgress {
  packageName: string
  stage: 'download' | 'extract' | 'copy' | 'install'
  progress: number
}

export interface LocalLibraryEntry {
  id: string
  releaseName: string
  path: string
  source: 'folder' | 'apk-file'
  apkCount: number
  hasInstallScript: boolean
  packageNames: string[]
  lastSeen: number
}

export interface LocalLibraryIndex {
  rootPath: string
  generatedAt: number
  entries: LocalLibraryEntry[]
}

// Update types
export interface CommitInfo {
  sha: string
  message: string
  author: string
  date: string
  url: string
}

export interface UpdateInfo {
  version: string
  releaseNotes?: string
  releaseDate?: string
  downloadUrl?: string
  commits?: CommitInfo[]
}

export interface UpdateProgressInfo {
  bytesPerSecond: number
  percent: number
  transferred: number
  total: number
}

// Dependency types
export interface DependencyStatus {
  sevenZip: {
    ready: boolean
    path: string | null
    error: string | null
  }
  rclone: {
    ready: boolean
    path: string | null
    error: string | null
    downloading: boolean
  }
  adb: {
    ready: boolean
    path: string | null
    error: string | null
    downloading: boolean
  }
  services: ServiceStatus
}

export interface BlacklistEntry {
  packageName: string
  version: number | 'any'
}

export interface AdbAPI {
  listDevices: () => Promise<DeviceInfo[]>
  connectDevice: (serial: string) => Promise<boolean>
  connectTcpDevice: (ipAddress: string, port?: number) => Promise<boolean>
  disconnectTcpDevice: (ipAddress: string, port?: number) => Promise<boolean>
  getDeviceIp: (serial: string) => Promise<string | null>
  getInstalledPackages: (serial: string) => Promise<PackageInfo[]>
  getApplicationLabel: (serial: string, packageName: string) => Promise<string | null>
  uninstallPackage: (serial: string, packageName: string) => Promise<boolean>
  startTrackingDevices: (mainWindow?: BrowserWindow) => void
  stopTrackingDevices: () => void
  getUserName: (serial: string) => Promise<string>
  setUserName: (serial: string, name: string) => Promise<void>
  pingDevice: (ipAddress: string) => Promise<{ reachable: boolean; responseTime?: number }>
}

export interface DependencyAPI {
  getStatus: () => Promise<DependencyStatus>
}

export interface DependencyAPIRenderer extends DependencyAPI {}

export interface AdbAPIRenderer extends AdbAPI {
  onDeviceAdded: (callback: (device: DeviceInfo) => void) => () => void
  onDeviceRemoved: (callback: (device: DeviceInfo) => void) => () => void
  onDeviceChanged: (callback: (device: DeviceInfo) => void) => () => void
  onTrackerError: (callback: (error: string) => void) => () => void
  onInstallationCompleted: (callback: (deviceId: string) => void) => () => void
}

export interface GamesAPI {
  getGames: () => Promise<GameInfo[]>
  getLastSyncTime: () => Promise<Date | null>
  forceSync: () => Promise<GameInfo[]>
  getNote: (releaseName: string) => Promise<string>
  getBlacklistGames: () => Promise<BlacklistEntry[]>
  getTrailerVideoId: (gameName: string) => Promise<string | null>
  addToBlacklist: (packageName: string, version?: number | 'any') => Promise<boolean>
  removeFromBlacklist: (packageName: string) => Promise<boolean>
  isGameBlacklisted: (packageName: string, version?: number) => boolean
}

export interface GameAPIRenderer
  extends Modify<
    GamesAPI,
    {
      isGameBlacklisted: (packageName: string, version?: number) => Promise<boolean>
    }
  > {
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => () => void
}

export interface DownloadAPI {
  getQueue: () => Promise<DownloadItem[]>
  addToQueue: (game: GameInfo, options?: DownloadAddOptions) => Promise<boolean>
  removeFromQueue: (releaseName: string) => Promise<void>
  cancelUserRequest: (releaseName: string) => void
  retryDownload: (releaseName: string) => void
  pauseDownload: (releaseName: string) => void
  resumeDownload: (releaseName: string) => void
  deleteDownloadedFiles: (releaseName: string) => Promise<boolean>
  setDownloadPath: (path: string) => void
  setAppConnectionState: (selectedDevice: string | null, isConnected: boolean) => void
}

export interface DownloadAPIRenderer extends DownloadAPI {
  onQueueUpdated: (callback: (queue: DownloadItem[]) => void) => () => void
  installFromCompleted: (releaseName: string, deviceId: string) => Promise<void>
  installManualFile: (filePath: string, deviceId: string) => Promise<boolean>
  copyObbFolder: (folderPath: string, deviceId: string) => Promise<boolean>
}

export interface LocalLibraryAPI {
  getIndex: () => Promise<LocalLibraryIndex>
  rescan: () => Promise<LocalLibraryIndex>
}

export interface LocalLibraryAPIRenderer extends LocalLibraryAPI {
  onUpdated: (callback: (index: LocalLibraryIndex) => void) => () => void
}

export interface UploadAPI {
  prepareUpload: (
    packageName: string,
    gameName: string,
    versionCode: number,
    deviceId: string
  ) => Promise<string | null>
  getQueue: () => Promise<UploadItem[]>
  addToQueue: (
    packageName: string,
    gameName: string,
    versionCode: number,
    deviceId: string
  ) => Promise<boolean>
  removeFromQueue: (packageName: string) => void
  cancelUpload: (packageName: string) => void
}

export interface UploadAPIRenderer extends UploadAPI {
  onUploadProgress: (callback: (progress: UploadPreparationProgress) => void) => () => void
  onQueueUpdated: (callback: (queue: UploadItem[]) => void) => () => void
}

// Update API
export interface UpdateAPI {
  checkForUpdates: () => Promise<void>
  openDownloadPage: (url: string) => void
  openReleasesPage: () => void
  openRepositoryPage: () => void
}

export interface UpdateAPIRenderer extends UpdateAPI {
  onCheckingForUpdate: (callback: () => void) => () => void
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void
  onUpdateError: (callback: (error: Error) => void) => () => void
}

export interface Settings {
  downloadPath: string
  downloadSpeedLimit: number
  uploadSpeedLimit: number
  hideAdultContent: boolean
  colorScheme: 'light' | 'dark'
}

export interface SettingsAPI {
  getDownloadPath: () => string
  setDownloadPath: (path: string) => void
  getDownloadSpeedLimit: () => number
  setDownloadSpeedLimit: (limit: number) => void
  getUploadSpeedLimit: () => number
  setUploadSpeedLimit: (limit: number) => void
  getColorScheme: () => 'light' | 'dark'
  setColorScheme: (scheme: 'light' | 'dark') => void
}

export interface SettingsAPIRenderer
  extends Modify<
    SettingsAPI,
    {
      getDownloadPath: () => Promise<string>
      setDownloadPath: (path: string) => Promise<void>
      getDownloadSpeedLimit: () => Promise<number>
      setDownloadSpeedLimit: (limit: number) => Promise<void>
      getUploadSpeedLimit: () => Promise<number>
      setUploadSpeedLimit: (limit: number) => Promise<void>
      getColorScheme: () => Promise<'light' | 'dark'>
      setColorScheme: (scheme: 'light' | 'dark') => Promise<void>
    }
  > {}

// Logs API
export interface LogsAPI {
  uploadCurrentLog: () => Promise<{ url: string; password: string } | null>
}

export interface LogsAPIRenderer extends LogsAPI {}

export type ServiceStatus = 'NOT_INITIALIZED' | 'INITIALIZING' | 'INITIALIZED' | 'ERROR'

// Mirror types - all mirrors use rclone
export interface MirrorConfig {
  id: string
  name: string
  type: string // rclone type (ftp, http, webdav, etc.)
  host: string
  port?: number
  user?: string
  pass?: string
  path?: string
  md5sum_command?: string
  sha1sum_command?: string
  // Additional rclone config options can be stored as key-value pairs
  [key: string]: unknown
}

export interface Mirror {
  id: string
  name: string
  config: MirrorConfig
  isActive: boolean
  lastTested?: Date
  testStatus: 'untested' | 'testing' | 'success' | 'failed'
  testError?: string
  addedDate: Date
}

export interface MirrorTestResult {
  id: string
  success: boolean
  responseTime?: number
  error?: string
  timestamp: Date
}

// Mirror API
export interface MirrorAPI {
  getMirrors: () => Promise<Mirror[]>
  addMirror: (configFile: string) => Promise<boolean>
  removeMirror: (id: string) => Promise<boolean>
  setActiveMirror: (id: string) => Promise<boolean>
  clearActiveMirror: () => Promise<boolean>
  testMirror: (id: string) => Promise<MirrorTestResult>
  testAllMirrors: () => Promise<MirrorTestResult[]>
  getActiveMirror: () => Promise<Mirror | null>
}

export interface MirrorAPIRenderer extends MirrorAPI {
  onMirrorTestProgress: (
    callback: (id: string, status: 'testing' | 'success' | 'failed', error?: string) => void
  ) => () => void
  onMirrorsUpdated: (callback: (mirrors: Mirror[]) => void) => () => void
  importFromFile: () => Promise<string | null>
}
