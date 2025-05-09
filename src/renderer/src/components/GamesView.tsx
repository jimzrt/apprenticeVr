import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  ColumnDef,
  flexRender,
  SortingState,
  FilterFn,
  ColumnFiltersState,
  Row
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAdb } from '../hooks/useAdb'
import { useGames } from '../hooks/useGames'
import { useDownload } from '../hooks/useDownload'
import { GameInfo } from '../types/adb'
import placeholderImage from '../assets/images/game-placeholder.png'
import {
  Button,
  tokens,
  shorthands,
  makeStyles,
  Title2,
  Text,
  Input,
  Badge,
  ProgressBar,
  Spinner
} from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  DismissRegular,
  PlugDisconnectedRegular,
  CheckmarkCircleRegular,
  DesktopRegular,
  BatteryChargeRegular,
  StorageRegular
} from '@fluentui/react-icons'
import { ArrowLeftRegular } from '@fluentui/react-icons'
import GameDetailsDialog from './GameDetailsDialog'

interface GamesViewProps {
  onBackToDevices: () => void
}

type FilterType = 'all' | 'installed' | 'update'

const filterGameNameAndPackage: FilterFn<GameInfo> = (row, _columnId, filterValue) => {
  const searchStr = String(filterValue).toLowerCase()
  const gameName = String(row.original.name ?? '').toLowerCase()
  const packageName = String(row.original.packageName ?? '').toLowerCase()
  return gameName.includes(searchStr) || packageName.includes(searchStr)
}

declare module '@tanstack/react-table' {
  interface FilterFns {
    gameNameAndPackageFilter: FilterFn<GameInfo>
  }
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    ...shorthands.borderBottom(tokens.strokeWidthThin, 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground3,
    flexShrink: 0
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM
  },
  deviceInfoBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  connectedDeviceText: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS
  },
  deviceWarningText: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteRedForeground1
  },
  tableContainer: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    overflow: 'hidden'
  },
  toolbar: {
    marginBottom: tokens.spacingVerticalL,
    flexShrink: 0
  },
  filterButtons: {
    display: 'flex',
    gap: tokens.spacingHorizontalS
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM
  },
  searchInput: {
    width: '250px'
  },
  statusArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    ...shorthands.padding(tokens.spacingVerticalXXL),
    flexGrow: 1
  },
  progressBarContainer: {
    width: '100%',
    maxWidth: '400px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    alignItems: 'center'
  },
  tableWrapper: {
    flexGrow: 1,
    overflow: 'auto',
    position: 'relative'
  },
  namePackageCellContainer: {
    position: 'relative',
    paddingBottom: '8px',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center'
  },
  namePackageCellText: {},
  progressBarAcrossRow: {
    position: 'absolute',
    bottom: '0',
    left: '0',
    right: '0',
    height: '4px'
  },
  statusIconCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%'
  },
  resizer: {
    position: 'absolute',
    right: 0,
    top: 0,
    height: '100%',
    width: '5px',
    background: 'rgba(0, 0, 0, 0.1)',
    cursor: 'col-resize',
    userSelect: 'none',
    touchAction: 'none',
    opacity: 0,
    transition: 'opacity 0.2s ease-in-out',
    ':hover': {
      opacity: 1
    }
  },
  isResizing: {
    background: tokens.colorBrandBackground,
    opacity: 1
  }
})

const GamesView: React.FC<GamesViewProps> = ({ onBackToDevices }) => {
  const {
    selectedDevice,
    selectedDeviceDetails,
    isConnected,
    disconnectDevice,
    isLoading: adbLoading,
    loadPackages
  } = useAdb()
  const {
    games,
    isLoading: loadingGames,
    error: gamesError,
    lastSyncTime,
    downloadProgress,
    extractProgress,
    refreshGames,
    getNote
  } = useGames()
  const {
    addToQueue: addDownloadToQueue,
    queue: downloadQueue,
    cancelDownload,
    retryDownload,
    deleteFiles
  } = useDownload()

  const styles = useStyles()

  const [globalFilter, setGlobalFilter] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [activeFilter, setActiveFilter] = useState<FilterType>('all')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [dialogGame, setDialogGame] = useState<GameInfo | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState<boolean>(false)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const counts = useMemo(() => {
    const total = games.length
    const installed = games.filter((g) => g.isInstalled).length
    const updates = games.filter((g) => g.hasUpdate).length
    return { total, installed, updates }
  }, [games])

  useEffect(() => {
    setColumnFilters((prev) => {
      const otherFilters = prev.filter((f) => f.id !== 'isInstalled' && f.id !== 'hasUpdate')
      switch (activeFilter) {
        case 'installed':
          return [...otherFilters, { id: 'isInstalled', value: true }]
        case 'update':
          return [
            ...otherFilters,
            { id: 'isInstalled', value: true },
            { id: 'hasUpdate', value: true }
          ]
        case 'all':
        default:
          return otherFilters
      }
    })
  }, [activeFilter])

  useEffect(() => {
    const unsubscribe = window.api.adb.onInstallationCompleted((deviceId) => {
      console.log(`[GamesView] Received installation-completed event for device: ${deviceId}`)
      if (selectedDevice && deviceId === selectedDevice) {
        console.log(`[GamesView] Refreshing packages for current device ${selectedDevice}...`)
        loadPackages()
          .then(() => console.log('[GamesView] Package refresh triggered successfully.'))
          .catch((err) => console.error('[GamesView] Error triggering package refresh:', err))
      } else {
        console.log(
          `[GamesView] Installation completed event for non-selected device (${deviceId}), ignoring.`
        )
      }
    })

    return () => {
      console.log('[GamesView] Cleaning up installation completed listener.')
      unsubscribe()
    }
  }, [selectedDevice, loadPackages])

  const downloadStatusMap = useMemo(() => {
    const map = new Map<string, { status: string; progress: number }>()
    downloadQueue.forEach((item) => {
      if (item.releaseName) {
        const progress =
          item.status === 'Extracting' ? (item.extractProgress ?? 0) : (item.progress ?? 0)
        map.set(item.releaseName, {
          status: item.status,
          progress: progress
        })
      }
    })
    return map
  }, [downloadQueue])

  const columns = useMemo<ColumnDef<GameInfo>[]>(
    () => [
      {
        id: 'downloadStatus',
        header: '',
        size: 60,
        enableResizing: false,
        enableSorting: false,
        cell: ({ row }) => {
          const game = row.original
          const downloadInfo = game.releaseName
            ? downloadStatusMap.get(game.releaseName)
            : undefined
          const isDownloaded = downloadInfo?.status === 'Completed'
          const isInstalled = game.isInstalled
          const isUpdateAvailable = game.hasUpdate

          return (
            <div className={styles.statusIconCell}>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
                {isDownloaded && (
                  <DesktopRegular
                    fontSize={16}
                    color={tokens.colorNeutralForeground3}
                    aria-label="Installed"
                  />
                )}
                {isInstalled && (
                  <CheckmarkCircleRegular
                    fontSize={16}
                    color={tokens.colorPaletteGreenForeground1}
                    aria-label="Downloaded"
                  />
                )}
                {isUpdateAvailable && (
                  <ArrowClockwiseRegular
                    fontSize={16}
                    color={tokens.colorPaletteGreenForeground1}
                    aria-label="Update Available"
                  />
                )}
              </div>
            </div>
          )
        }
      },
      {
        accessorKey: 'thumbnailPath',
        header: ' ',
        size: 90,
        enableResizing: false,
        cell: ({ getValue }) => {
          const path = getValue<string>()
          return (
            <div className="game-thumbnail-cell">
              <img
                src={path ? `file://${path}` : placeholderImage}
                alt="Thumbnail"
                className="game-thumbnail-img"
              />
            </div>
          )
        },
        enableSorting: false
      },
      {
        accessorKey: 'name',
        header: 'Name / Package',
        size: 430,
        cell: ({ row }) => {
          const game = row.original
          const downloadInfo = game.releaseName
            ? downloadStatusMap.get(game.releaseName)
            : undefined
          const isDownloading = downloadInfo?.status === 'Downloading'
          const isExtracting = downloadInfo?.status === 'Extracting'
          const isQueued = downloadInfo?.status === 'Queued'
          const isInstalling = downloadInfo?.status === 'Installing'
          const isInstallError = downloadInfo?.status === 'InstallError'

          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                height: '100%',
                position: 'relative',
                paddingBottom: '8px'
              }}
            >
              <div style={{ marginBottom: tokens.spacingVerticalXS }}>
                {' '}
                <div className="game-name-main">{game.name}</div>
                <div className="game-package-sub">{game.releaseName}</div>
                <div className="game-package-sub">{game.packageName}</div>
              </div>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}
              >
                {isQueued && (
                  <Badge shape="rounded" color="informative" appearance="outline">
                    Queued
                  </Badge>
                )}
                {isInstalling && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacingHorizontalXS
                    }}
                  >
                    <Spinner size="tiny" aria-label="Installing" />
                    <Badge shape="rounded" color="brand" appearance="outline">
                      Installing
                    </Badge>
                  </div>
                )}
                {isInstallError && (
                  <Badge shape="rounded" color="danger" appearance="outline">
                    Install Error
                  </Badge>
                )}
              </div>
              {(isDownloading || isExtracting) && !isInstalling && downloadInfo && (
                <ProgressBar
                  value={downloadInfo.progress}
                  max={100}
                  shape="rounded"
                  thickness="medium"
                  className={styles.progressBarAcrossRow}
                  aria-label={isDownloading ? 'Download progress' : 'Extraction progress'}
                />
              )}
            </div>
          )
        },
        enableResizing: true
      },
      {
        accessorKey: 'version',
        header: 'Version',
        size: 180,
        cell: ({ row }) => {
          const listVersion = row.original.version
          const isInstalled = row.original.isInstalled
          const deviceVersion = row.original.deviceVersionCode
          const displayListVersion = listVersion ? `v${listVersion}` : '-'
          return (
            <div className="version-cell">
              <div className="list-version-main">{displayListVersion}</div>
              {isInstalled && (
                <div className="installed-version-info">
                  {deviceVersion !== undefined ? `Installed: v${deviceVersion}` : 'Installed'}
                </div>
              )}
            </div>
          )
        },
        enableResizing: true
      },
      {
        accessorKey: 'downloads',
        header: 'Popularity',
        size: 120,
        cell: (info) => {
          const count = info.getValue<number>()
          return typeof count === 'number' ? count.toLocaleString() : '-'
        },
        enableResizing: true
      },
      {
        accessorKey: 'size',
        header: 'Size',
        size: 90,
        cell: (info) => info.getValue() || '-',
        enableResizing: true
      },

      {
        accessorKey: 'lastUpdated',
        header: 'Last Updated',
        size: 180,
        cell: (info) => info.getValue() || '-',
        enableResizing: true
      },
      {
        accessorKey: 'isInstalled',
        header: 'Installed Status',
        enableResizing: false
      },
      {
        accessorKey: 'hasUpdate',
        header: 'Update Status',
        enableResizing: false
      }
    ],
    [downloadStatusMap, styles]
  )

  const table = useReactTable({
    data: games,
    columns,
    columnResizeMode: 'onChange',
    filterFns: {
      gameNameAndPackageFilter: filterGameNameAndPackage
    },
    state: {
      sorting,
      globalFilter,
      columnFilters,
      columnVisibility: { isInstalled: false, hasUpdate: false }
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    globalFilterFn: 'gameNameAndPackageFilter',
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel()
  })

  const { rows } = table.getRowModel()
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 90,
    overscan: 10
  })

  const formatDate = (date: Date | null): string => {
    if (!date) return 'Never'
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  }

  const getProcessMessage = (): string => {
    if (downloadProgress > 0 && downloadProgress < 100) {
      return `Downloading game data... ${downloadProgress}%`
    } else if (extractProgress > 0 && extractProgress < 100) {
      return `Extracting game data... ${extractProgress}%`
    } else if (loadingGames) {
      return 'Preparing game library...'
    }
    return ''
  }

  const getCurrentProgress = (): number => {
    if (downloadProgress > 0 && downloadProgress < 100) {
      return downloadProgress
    } else if (extractProgress > 0 && extractProgress < 100) {
      return extractProgress
    }
    return 0
  }

  const handleRowClick = (
    _event: React.MouseEvent<HTMLTableRowElement>,
    row: Row<GameInfo>
  ): void => {
    console.log('Row clicked for game:', row.original.name)
    setDialogGame(row.original)
    setIsDialogOpen(true)
  }

  const handleCloseDialog = useCallback((): void => {
    setIsDialogOpen(false)
    setTimeout(() => {
      setDialogGame(null)
    }, 300)
  }, [])

  const handleInstall = (game: GameInfo | null): void => {
    if (!game) return
    console.log('Install action triggered for:', game.packageName)
    addDownloadToQueue(game)
      .then((success) => {
        if (success) {
          console.log(`Successfully added ${game.releaseName} to download queue.`)
        } else {
          console.log(`Failed to add ${game.releaseName} to queue (might already exist).`)
        }
      })
      .catch((err) => {
        console.error('Error adding to queue:', err)
      })
    handleCloseDialog()
  }

  const handleReinstall = async (game: GameInfo | null): Promise<void> => {
    if (!game || !game.packageName || !game.releaseName || !selectedDevice) {
      console.error(
        'Reinstall Error: Missing game data, package name, release name, or device ID.',
        {
          game,
          selectedDevice
        }
      )
      window.alert('Cannot start reinstall: Essential information is missing.')
      handleCloseDialog() // Ensure dialog closes even on early exit
      return
    }

    console.log(`Reinstall: Starting for ${game.name} (${game.packageName}) on ${selectedDevice}.`)
    setIsLoading(true)
    handleCloseDialog() // Close dialog before starting potentially long operation

    try {
      // Step 1: Uninstall the package
      console.log(`Reinstall: Attempting to uninstall ${game.packageName}...`)
      const uninstallSuccess = await window.api.adb.uninstallPackage(
        selectedDevice,
        game.packageName
      )

      if (uninstallSuccess) {
        console.log(`Reinstall: Successfully uninstalled ${game.packageName}.`)
        // The game is now uninstalled from the device.
        // Downloaded files (if any) should still be present.

        const downloadInfo = downloadStatusMap.get(game.releaseName)

        if (downloadInfo?.status === 'Completed') {
          console.log(
            `Reinstall: Files for ${game.releaseName} are 'Completed'. Initiating install from completed.`
          )
          await window.api.downloads.installFromCompleted(game.releaseName, selectedDevice)
          console.log(`Reinstall: 'installFromCompleted' called for ${game.releaseName}.`)
        } else {
          console.log(
            `Reinstall: Files for ${game.releaseName} not 'Completed' (status: ${downloadInfo?.status}). Adding to download queue.`
          )
          const addToQueueSuccess = await addDownloadToQueue(game)
          if (addToQueueSuccess) {
            console.log(`Reinstall: Successfully added ${game.releaseName} to download queue.`)
          } else {
            console.warn(
              `Reinstall: Failed to add ${game.releaseName} to queue. Current status: ${downloadInfo?.status}.`
            )
            window.alert(
              `Reinstall for ${game.name} failed: Could not add to download queue. Please check logs.`
            )
          }
        }
      } else {
        console.error(
          `Reinstall: Failed to uninstall ${game.packageName}. Installation step will be skipped.`
        )
        window.alert(`Failed to uninstall ${game.name}. Reinstall aborted.`)
      }
    } catch (error) {
      console.error(`Reinstall: Error during process for ${game.name}:`, error)
      window.alert(
        `An error occurred during the reinstall process for ${game.name}. Please check logs.`
      )
    } finally {
      setIsLoading(false)
      // Refresh packages to update UI. The 'installation-completed' event should also trigger this,
      // but it's good to have a fallback or an immediate refresh after the uninstall part.
      console.log(`Reinstall: Process finished for ${game.name}. Triggering package refresh.`)
      loadPackages().catch((err) =>
        console.error('Reinstall: Error refreshing packages post-operation:', err)
      )
    }
  }

  const handleUpdate = async (game: GameInfo | null): Promise<void> => {
    if (!game || !game.releaseName || !selectedDevice) {
      console.error('Update action aborted: Missing game data, releaseName, or selectedDevice.', {
        game,
        selectedDevice
      })
      window.alert('Cannot start update: Essential information is missing.')
      handleCloseDialog()
      return
    }

    console.log(
      `Update action triggered for: ${game.name} (${game.packageName}) on ${selectedDevice}`
    )
    handleCloseDialog() // Close dialog early

    try {
      const downloadInfo = downloadStatusMap.get(game.releaseName)

      if (downloadInfo?.status === 'Completed') {
        console.log(
          `Update for ${game.releaseName}: Files are already 'Completed'. Initiating install from completed.`
        )
        await window.api.downloads.installFromCompleted(game.releaseName, selectedDevice)
        console.log(`Update: 'installFromCompleted' called for ${game.releaseName}.`)
        // Optionally, refresh packages or rely on 'installation-completed' event
        // loadPackages().catch(err => console.error('Update: Error refreshing packages post-install:', err));
      } else {
        console.log(
          `Update for ${game.releaseName}: Files not 'Completed' (status: ${downloadInfo?.status}). Adding to download queue.`
        )
        const addToQueueSuccess = await addDownloadToQueue(game)
        if (addToQueueSuccess) {
          console.log(`Update: Successfully added ${game.releaseName} to download queue.`)
        } else {
          console.warn(
            `Update: Failed to add ${game.releaseName} to queue. Current status: ${downloadInfo?.status}.`
          )
          window.alert(
            `Could not queue ${game.name} for update. It might already be in the queue or an error occurred. Please check logs.`
          )
        }
      }
    } catch (error) {
      console.error(`Update: Error during process for ${game.name}:`, error)
      window.alert(
        `An error occurred during the update process for ${game.name}. Please check logs.`
      )
    }
  }

  const handleRetry = (game: GameInfo | null): void => {
    if (!game || !game.releaseName) return
    console.log('Retry action triggered for:', game.releaseName)
    retryDownload(game.releaseName)
    handleCloseDialog()
  }

  const handleCancelDownload = (game: GameInfo | null): void => {
    if (!game || !game.releaseName) return
    console.log('Cancel download/extraction action triggered for:', game.releaseName)
    cancelDownload(game.releaseName)
    handleCloseDialog()
  }

  const handleInstallFromCompleted = (game: GameInfo | null): void => {
    if (!game || !game.releaseName || !selectedDevice) {
      console.error('Missing game, releaseName, or deviceId for install from completed action')
      window.alert('Cannot start installation: Missing required information.')
      return
    }
    console.log(`Requesting install from completed for ${game.releaseName} on ${selectedDevice}`)
    window.api.downloads.installFromCompleted(game.releaseName, selectedDevice).catch((err) => {
      console.error('Error triggering install from completed:', err)
      window.alert('Failed to start installation. Please check the main process logs.')
    })
    handleCloseDialog()
  }

  const handleConfirmDelete = useCallback(
    async (gameToDelete: GameInfo): Promise<void> => {
      if (!selectedDevice || !gameToDelete.packageName) {
        console.error('Cannot delete: Missing selected device or package name', {
          selectedDevice,
          packageName: gameToDelete.packageName
        })
        window.alert('Failed to uninstall: Missing device or package name.')
        return
      }
      handleCloseDialog()
      console.log(`Proceeding with uninstall for ${gameToDelete.packageName}...`)
      setIsLoading(true)
      try {
        const success = await window.api.adb.uninstallPackage(
          selectedDevice,
          gameToDelete.packageName
        )
        if (success) {
          console.log('Uninstall successful, refreshing package list...')
          await loadPackages()
        } else {
          console.error('Uninstall failed.')
          window.alert('Failed to uninstall the game.')
        }
      } catch (error) {
        console.error('Error during uninstall IPC call:', error)
        window.alert('An error occurred during uninstallation.')
      } finally {
        setIsLoading(false)
      }
    },
    [selectedDevice, loadPackages, handleCloseDialog]
  )

  const handleDeleteDownloaded = useCallback(
    async (game: GameInfo | null): Promise<void> => {
      if (!game || !game.releaseName) return
      console.log('Delete downloaded files action triggered for:', game.releaseName)
      try {
        const success = await deleteFiles(game.releaseName)
        if (success) {
          console.log(`Successfully requested deletion of files for ${game.releaseName}.`)
        } else {
          console.error(`Failed to delete files for ${game.releaseName}.`)
          window.alert('Failed to delete downloaded files. Check logs.')
        }
      } catch (error) {
        console.error('Error calling deleteFiles:', error)
        window.alert('An error occurred while trying to delete downloaded files.')
      }
      handleCloseDialog()
    },
    [deleteFiles, handleCloseDialog]
  )

  const isBusy = adbLoading || loadingGames || isLoading

  return (
    <div className="games-view">
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Button icon={<ArrowLeftRegular />} onClick={onBackToDevices} appearance="transparent">
            Back to Devices
          </Button>
          <Title2>Library</Title2>
        </div>
        <div className={styles.deviceInfoBar}>
          {isConnected ? (
            <>
              <Text className={styles.connectedDeviceText}>
                <CheckmarkCircleRegular fontSize={16} color={tokens.colorPaletteGreenForeground1} />
                Connected:{' '}
                <strong>{selectedDeviceDetails?.friendlyModelName || selectedDevice}</strong>
                {selectedDeviceDetails && selectedDeviceDetails.batteryLevel !== null && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      marginLeft: tokens.spacingHorizontalM
                    }}
                  >
                    <BatteryChargeRegular
                      fontSize={16}
                      style={{ marginRight: tokens.spacingHorizontalXXS }}
                    />
                    {selectedDeviceDetails.batteryLevel}%
                  </span>
                )}
                {selectedDeviceDetails &&
                  selectedDeviceDetails.storageFree !== null &&
                  selectedDeviceDetails.storageTotal !== null && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        marginLeft: tokens.spacingHorizontalM
                      }}
                    >
                      <StorageRegular
                        fontSize={16}
                        style={{ marginRight: tokens.spacingHorizontalXXS }}
                      />
                      {`${selectedDeviceDetails.storageFree} / ${selectedDeviceDetails.storageTotal}`}
                    </span>
                  )}
              </Text>
              <Button
                icon={<DismissRegular />}
                onClick={disconnectDevice}
                appearance="subtle"
                size="small"
                aria-label="Disconnect device"
              />
            </>
          ) : (
            <Text className={styles.deviceWarningText}>
              <PlugDisconnectedRegular fontSize={16} /> No device connected
            </Text>
          )}
        </div>
      </header>

      <div className="games-container-table">
        <div className="games-toolbar">
          <div className="games-toolbar-left">
            <Button icon={<ArrowClockwiseRegular />} onClick={refreshGames} disabled={isBusy}>
              {isBusy ? 'Working...' : 'Refresh Games'}
            </Button>
            <Button
              icon={<ArrowClockwiseRegular />}
              onClick={() => loadPackages()}
              disabled={isBusy || !isConnected}
              title={
                !isConnected
                  ? 'Connect a device to refresh its packages'
                  : 'Refresh installed packages on the device'
              }
            >
              {isBusy ? 'Working...' : 'Refresh Quest'}
            </Button>
            <span className="last-synced">Last synced: {formatDate(lastSyncTime)}</span>
            {isConnected && (
              <div className="filter-buttons">
                <button
                  onClick={() => setActiveFilter('all')}
                  className={activeFilter === 'all' ? 'active' : ''}
                >
                  All ({counts.total})
                </button>
                <button
                  onClick={() => setActiveFilter('installed')}
                  className={activeFilter === 'installed' ? 'active' : ''}
                >
                  Installed ({counts.installed})
                </button>
                <button
                  onClick={() => setActiveFilter('update')}
                  className={activeFilter === 'update' ? 'active' : ''}
                  disabled={counts.updates === 0}
                >
                  Updates ({counts.updates})
                </button>
              </div>
            )}
          </div>
          <div className="games-toolbar-right">
            <span className="game-count">{table.getFilteredRowModel().rows.length} displayed</span>
            <Input
              value={globalFilter ?? ''}
              onChange={(e) => setGlobalFilter(String(e.target.value))}
              placeholder="Search name/package..."
              type="search"
            />
          </div>
        </div>

        {isBusy && !loadingGames && !downloadProgress && !extractProgress && (
          <div className="loading-indicator">Processing...</div>
        )}

        {loadingGames && (downloadProgress > 0 || extractProgress > 0) && (
          <div className="download-progress">
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${getCurrentProgress()}%` }} />
            </div>
            <div className="progress-text">{getProcessMessage()}</div>
          </div>
        )}

        {loadingGames ? (
          <div className="loading-indicator">Loading games library...</div>
        ) : gamesError ? (
          <div className="error-message">{gamesError}</div>
        ) : games.length === 0 && !loadingGames ? (
          <div className="no-games-message">
            No games found. Click &quot;Refresh Games&quot; to sync the game library.
          </div>
        ) : (
          <>
            <div className="table-wrapper" ref={tableContainerRef}>
              <table className="games-table" style={{ width: table.getTotalSize() }}>
                <thead
                  style={{
                    display: 'grid',
                    position: 'sticky',
                    top: 0,
                    zIndex: 1
                  }}
                >
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          colSpan={header.colSpan}
                          style={{ width: header.getSize(), position: 'relative' }}
                        >
                          {header.isPlaceholder ? null : (
                            <div
                              {...{
                                className: header.column.getCanSort()
                                  ? 'cursor-pointer select-none'
                                  : '',
                                onClick: header.column.getToggleSortingHandler()
                              }}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: ' 🔼',
                                desc: ' 🔽'
                              }[header.column.getIsSorted() as string] ?? null}
                            </div>
                          )}
                          {header.column.getCanResize() && (
                            <div
                              onMouseDown={header.getResizeHandler()}
                              onTouchStart={header.getResizeHandler()}
                              className={`${styles.resizer} ${header.column.getIsResizing() ? styles.isResizing : ''}`}
                            />
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody
                  style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index] as Row<GameInfo>
                    const rowClasses = [
                      row.original.isInstalled ? 'row-installed' : 'row-not-installed',
                      row.original.hasUpdate ? 'row-update-available' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')

                    return (
                      <tr
                        key={row.id}
                        className={rowClasses}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`
                        }}
                        onClick={(e) => handleRowClick(e, row)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            style={{
                              width: cell.column.getSize(),
                              maxWidth: cell.column.getSize()
                            }}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {dialogGame && (
              <GameDetailsDialog
                game={dialogGame}
                open={isDialogOpen}
                onClose={handleCloseDialog}
                downloadStatusMap={downloadStatusMap}
                onInstall={handleInstall}
                onReinstall={handleReinstall}
                onUpdate={handleUpdate}
                onRetry={handleRetry}
                onCancelDownload={handleCancelDownload}
                onConfirmDelete={handleConfirmDelete}
                onDeleteDownloaded={handleDeleteDownloaded}
                onInstallFromCompleted={handleInstallFromCompleted}
                getNote={getNote}
                isConnected={isConnected}
                isBusy={isBusy}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default GamesView
