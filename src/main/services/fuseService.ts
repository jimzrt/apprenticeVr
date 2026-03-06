import { shell } from 'electron'
import { existsSync } from 'fs'
import { execa } from 'execa'
import { FuseStatus } from '@shared/types'

class FuseService {
  private getInstallerUrl(): string | null {
    if (process.platform === 'darwin') return 'https://macfuse.github.io/'
    if (process.platform === 'linux') return 'https://github.com/libfuse/libfuse'
    return null
  }

  private async isMacFuseInstalled(): Promise<{ available: boolean; detectedBy?: string }> {
    const macFusePaths = [
      '/Library/Filesystems/macfuse.fs',
      '/Library/Filesystems/macfuse.fs/Contents/Resources/mount_macfuse',
      '/opt/homebrew/bin/mount_macfuse',
      '/usr/local/bin/mount_macfuse'
    ]

    for (const path of macFusePaths) {
      if (existsSync(path)) {
        return { available: true, detectedBy: path }
      }
    }

    try {
      const result = await execa('pkgutil', ['--pkgs'], {
        reject: false,
        timeout: 5000
      })
      if (
        result.stdout
          .split('\n')
          .some((line) => line.toLowerCase().includes('macfuse') || line.includes('io.macfuse'))
      ) {
        return { available: true, detectedBy: 'pkgutil' }
      }
    } catch (error) {
      console.warn('[FuseService] pkgutil detection failed:', error)
    }

    return { available: false }
  }

  private async isLinuxFuseInstalled(): Promise<{ available: boolean; detectedBy?: string }> {
    if (existsSync('/dev/fuse')) {
      return { available: true, detectedBy: '/dev/fuse' }
    }

    try {
      const fusermount3 = await execa('which', ['fusermount3'], { reject: false, timeout: 3000 })
      if (fusermount3.exitCode === 0 && fusermount3.stdout) {
        return { available: true, detectedBy: fusermount3.stdout.trim() }
      }

      const fusermount = await execa('which', ['fusermount'], { reject: false, timeout: 3000 })
      if (fusermount.exitCode === 0 && fusermount.stdout) {
        return { available: true, detectedBy: fusermount.stdout.trim() }
      }
    } catch (error) {
      console.warn('[FuseService] fusermount detection failed:', error)
    }

    return { available: false }
  }

  public async getStatus(): Promise<FuseStatus> {
    if (process.platform === 'darwin') {
      const detection = await this.isMacFuseInstalled()
      return {
        supported: true,
        available: detection.available,
        installable: true,
        platform: process.platform,
        message: detection.available
          ? 'FUSE is available for mount-based downloads.'
          : 'FUSE is not installed. Install macFUSE to enable mount-based downloads.',
        detectedBy: detection.detectedBy
      }
    }

    if (process.platform === 'linux') {
      const detection = await this.isLinuxFuseInstalled()
      return {
        supported: true,
        available: detection.available,
        installable: true,
        platform: process.platform,
        message: detection.available
          ? 'FUSE is available for mount-based downloads.'
          : 'FUSE is not available. Install FUSE (libfuse) for mount-based downloads.',
        detectedBy: detection.detectedBy
      }
    }

    return {
      supported: false,
      available: false,
      installable: false,
      platform: process.platform,
      message: 'FUSE mount support is not used on this platform.'
    }
  }

  public async openInstaller(): Promise<boolean> {
    const installerUrl = this.getInstallerUrl()
    if (!installerUrl) return false
    await shell.openExternal(installerUrl)
    return true
  }

  public async openRemovalGuide(): Promise<boolean> {
    if (process.platform === 'darwin') {
      const uninstallAppCandidates = [
        '/Library/Filesystems/macfuse.fs/Contents/Resources/uninstall-macfuse.app',
        '/Library/Filesystems/macfuse.fs/Contents/Resources/Uninstall macFUSE.app'
      ]

      for (const uninstallAppPath of uninstallAppCandidates) {
        if (!existsSync(uninstallAppPath)) continue
        const openPathResult = await shell.openPath(uninstallAppPath)
        if (!openPathResult) return true
      }

      await shell.openExternal('https://macfuse.github.io/')
      return true
    }

    if (process.platform === 'linux') {
      await shell.openExternal('https://github.com/libfuse/libfuse')
      return true
    }

    return false
  }
}

export default new FuseService()
