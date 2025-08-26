import React, { useState, useEffect, useRef } from 'react'
import {
  Card,
  CardHeader,
  Text,
  Button,
  Input,
  makeStyles,
  tokens,
  Spinner,
  Title2,
  Subtitle1,
  Dropdown,
  Option,
  Table,
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
  TableCellLayout
} from '@fluentui/react-components'
import {
  FolderOpenRegular,
  CheckmarkCircleRegular,
  InfoRegular,
  DeleteRegular,
  ShareRegular
} from '@fluentui/react-icons'
import { useSettings } from '../hooks/useSettings'
import { useGames } from '../hooks/useGames'
import { useLogs } from '../hooks/useLogs'
import { useDownload } from '../hooks/useDownload'

// Supported speed units with conversion factors to KB/s
const SPEED_UNITS = [
  { label: 'KB/s', value: 'kbps', factor: 1 },
  { label: 'MB/s', value: 'mbps', factor: 1024 }
]

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    position: 'relative',
    height: 'calc(100vh - 90px)', // Account for header height
    overflowY: 'auto',
    padding: tokens.spacingVerticalXL,
    backgroundColor: tokens.colorNeutralBackground1
  },
  contentContainer: {
    maxWidth: '1200px',
    width: '100%',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL
  },
  headerTitle: {
    marginBottom: tokens.spacingVerticalXS
  },
  headerSubtitle: {
    color: tokens.colorNeutralForeground2,
    display: 'block',
    marginBottom: tokens.spacingVerticalL
  },
  card: {
    width: '100%',
    boxShadow: tokens.shadow4,
    borderRadius: tokens.borderRadiusMedium
  },
  cardContent: {
    padding: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalXL
  },
  formRow: {
    display: 'flex',
    alignItems: 'center',
    marginTop: tokens.spacingVerticalM,
    gap: tokens.spacingHorizontalM,
    width: '100%',
    maxWidth: '800px',
    flexWrap: 'wrap'
  },
  input: {
    flexGrow: 1
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    marginTop: tokens.spacingVerticalXS
  },
  success: {
    color: tokens.colorPaletteGreenForeground1,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalXS
  },
  hint: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground2
  },
  speedLimitSection: {
    marginTop: tokens.spacingVerticalL
  },
  speedFormRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
    width: '100%',
    maxWidth: '800px'
  },
  speedControl: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS
  },
  speedInputGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS
  },
  speedInput: {
    width: '140px',
    flexGrow: 1
  },
  unitDropdown: {
    width: '80px',
    minWidth: '80px'
  },
  blacklistTable: {
    marginTop: tokens.spacingVerticalM,
    width: '100%',
    maxWidth: '800px'
  },
  emptyState: {
    marginTop: tokens.spacingVerticalL,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
    padding: tokens.spacingVerticalL
  },
  actionButton: {
    minWidth: 'auto'
  }
})

const BlacklistSettings: React.FC = () => {
  const styles = useStyles()
  const { getBlacklistGames, removeGameFromBlacklist } = useGames()
  const [blacklistGames, setBlacklistGames] = useState<
    { packageName: string; version: number | 'any' }[]
  >([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removeSuccess, setRemoveSuccess] = useState(false)

  const loadBlacklistGames = async (): Promise<void> => {
    try {
      setIsLoading(true)
      setError(null)
      const games = await getBlacklistGames()
      setBlacklistGames(games)
    } catch (err) {
      console.error('Error loading blacklisted games:', err)
      setError('Failed to load blacklisted games')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadBlacklistGames()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRemoveFromBlacklist = async (packageName: string): Promise<void> => {
    try {
      setError(null)
      await removeGameFromBlacklist(packageName)
      await loadBlacklistGames()
      setRemoveSuccess(true)

      setTimeout(() => {
        setRemoveSuccess(false)
      }, 3000)
    } catch (err) {
      console.error('Error removing game from blacklist:', err)
      setError('Failed to remove game from blacklist')
    }
  }

  return (
    <Card className={styles.card}>
      <CardHeader description={<Subtitle1 weight="semibold">Blacklisted Games</Subtitle1>} />
      <div className={styles.cardContent}>
        <Text>Manage games that will not prompt for uploads</Text>

        {isLoading ? (
          <div
            style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalL }}
          >
            <Spinner size="small" label="Loading blacklisted games..." />
          </div>
        ) : (
          <>
            {blacklistGames.length === 0 ? (
              <div className={styles.emptyState}>
                <Text>No blacklisted games found</Text>
              </div>
            ) : (
              <Table className={styles.blacklistTable}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Package Name</TableHeaderCell>
                    <TableHeaderCell>Version</TableHeaderCell>
                    <TableHeaderCell style={{ width: '100px' }}>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {blacklistGames.map((game) => (
                    <TableRow key={`${game.packageName}-${game.version}`}>
                      <TableCell>
                        <TableCellLayout>{game.packageName}</TableCellLayout>
                      </TableCell>
                      <TableCell>
                        <TableCellLayout>
                          {game.version === 'any' ? 'All Versions' : game.version}
                        </TableCellLayout>
                      </TableCell>
                      <TableCell>
                        <Button
                          icon={<DeleteRegular />}
                          appearance="subtle"
                          className={styles.actionButton}
                          onClick={() => handleRemoveFromBlacklist(game.packageName)}
                          aria-label="Remove from blacklist"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {error && <Text className={styles.error}>{error}</Text>}
            {removeSuccess && (
              <Text className={styles.success}>
                <CheckmarkCircleRegular />
                Game removed from blacklist successfully
              </Text>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

const LogUploadSettings: React.FC = () => {
  const styles = useStyles()
  const {
    isUploading,
    uploadError,
    uploadSuccess,
    shareableUrl,
    password,
    uploadCurrentLog,
    clearUploadState
  } = useLogs()

  const handleUploadLog = async (): Promise<void> => {
    clearUploadState()
    await uploadCurrentLog()
  }

  const handleCopyUrl = (): void => {
    if (shareableUrl) {
      navigator.clipboard.writeText(shareableUrl)
    }
  }

  const handleCopyPassword = (): void => {
    if (password) {
      navigator.clipboard.writeText(password)
    }
  }

  return (
    <Card className={styles.card}>
      <CardHeader description={<Subtitle1 weight="semibold">Log Upload</Subtitle1>} />
      <div className={styles.cardContent}>
        <Text>Upload the current log file to https://catbox.moe for sharing with support</Text>

        <div className={styles.formRow}>
          <Button
            onClick={handleUploadLog}
            appearance="primary"
            size="large"
            disabled={isUploading}
            icon={<ShareRegular />}
          >
            {isUploading ? 'Uploading...' : 'Upload Current Log'}
          </Button>
        </div>

        {uploadError && <Text className={styles.error}>{uploadError}</Text>}

        {uploadSuccess && shareableUrl && (
          <div className={styles.success}>
            <CheckmarkCircleRegular />
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <Text>Log uploaded successfully!</Text>

              <div
                style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}
              >
                <Text weight="semibold">URL:</Text>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}
                >
                  <Input
                    value={shareableUrl}
                    readOnly
                    style={{ flexGrow: 1, fontFamily: 'monospace', fontSize: '12px' }}
                  />
                  <Button onClick={handleCopyUrl} size="small" appearance="secondary">
                    Copy URL
                  </Button>
                </div>
              </div>

              {password && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: tokens.spacingVerticalXS
                  }}
                >
                  <Text weight="semibold">Password:</Text>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacingHorizontalS
                    }}
                  >
                    <Input
                      value={password}
                      readOnly
                      style={{
                        width: '200px',
                        fontFamily: 'monospace',
                        fontSize: '14px',
                        fontWeight: 'bold'
                      }}
                    />
                    <Button onClick={handleCopyPassword} size="small" appearance="secondary">
                      Copy Password
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <Text className={styles.hint}>
          <InfoRegular />
          The uploaded log file will be available on catbox.moe. Share only the URL with support for
          troubleshooting.
        </Text>
      </div>
    </Card>
  )
}

const Settings: React.FC = () => {
  const styles = useStyles()
  const {
    downloadPath,
    downloadSpeedLimit,
    uploadSpeedLimit,
    isLoading,
    error,
    setDownloadPath,
    setDownloadSpeedLimit,
    setUploadSpeedLimit
  } = useSettings()
  const [editedDownloadPath, setEditedDownloadPath] = useState(downloadPath)

  // New state for speed input values
  const [downloadSpeedInput, setDownloadSpeedInput] = useState(
    downloadSpeedLimit > 0 ? String(downloadSpeedLimit) : ''
  )
  const [uploadSpeedInput, setUploadSpeedInput] = useState(
    uploadSpeedLimit > 0 ? String(uploadSpeedLimit) : ''
  )
  const [downloadSpeedUnit, setDownloadSpeedUnit] = useState(SPEED_UNITS[0].value)
  const [uploadSpeedUnit, setUploadSpeedUnit] = useState(SPEED_UNITS[0].value)

  // Add refs to store original values in KB/s
  const originalDownloadKbps = useRef<number | null>(null)
  const originalUploadKbps = useRef<number | null>(null)

  const [localError, setLocalError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [refreshResults, setRefreshResults] = useState<{ added: number; updated: number; total: number } | null>(null)

  // Update local state when the context values change
  useEffect(() => {
    setEditedDownloadPath(downloadPath)

    // Handle new download/upload speed state
    if (downloadSpeedLimit === 0) {
      setDownloadSpeedInput('')
      originalDownloadKbps.current = null
    } else {
      setDownloadSpeedInput(String(downloadSpeedLimit))
      setDownloadSpeedUnit('kbps') // Always reset to KB/s when loading from settings
      originalDownloadKbps.current = downloadSpeedLimit
    }

    if (uploadSpeedLimit === 0) {
      setUploadSpeedInput('')
      originalUploadKbps.current = null
    } else {
      setUploadSpeedInput(String(uploadSpeedLimit))
      setUploadSpeedUnit('kbps') // Always reset to KB/s when loading from settings
      originalUploadKbps.current = uploadSpeedLimit
    }
  }, [downloadPath, downloadSpeedLimit, uploadSpeedLimit])

  const handleSaveDownloadPath = async (): Promise<void> => {
    if (!editedDownloadPath) {
      setLocalError('Download path cannot be empty')
      return
    }

    try {
      setLocalError(null)
      setSaveSuccess(false)
      await setDownloadPath(editedDownloadPath)

      // Show success message
      setSaveSuccess(true)

      // Reset success message after 3 seconds
      setTimeout(() => {
        setSaveSuccess(false)
      }, 3000)
    } catch (err) {
      console.error('Error saving download path:', err)
      setLocalError('Failed to save download path')
    }
  }

  const handleSaveSpeedLimits = async (): Promise<void> => {
    try {
      setLocalError(null)
      setSaveSuccess(false)

      // Use the stored original KB/s values if available, otherwise calculate
      let downloadLimit: number
      let uploadLimit: number

      if (downloadSpeedInput.trim() === '') {
        downloadLimit = 0
      } else if (originalDownloadKbps.current !== null) {
        downloadLimit = originalDownloadKbps.current
      } else {
        const inputValue = parseFloat(downloadSpeedInput)
        if (isNaN(inputValue)) {
          setLocalError('Please enter valid numbers for speed limits')
          return
        }
        const factor = SPEED_UNITS.find((u) => u.value === downloadSpeedUnit)?.factor || 1
        downloadLimit = inputValue * factor
      }

      if (uploadSpeedInput.trim() === '') {
        uploadLimit = 0
      } else if (originalUploadKbps.current !== null) {
        uploadLimit = originalUploadKbps.current
      } else {
        const inputValue = parseFloat(uploadSpeedInput)
        if (isNaN(inputValue)) {
          setLocalError('Please enter valid numbers for speed limits')
          return
        }
        const factor = SPEED_UNITS.find((u) => u.value === uploadSpeedUnit)?.factor || 1
        uploadLimit = inputValue * factor
      }

      // Ensure values are non-negative
      downloadLimit = Math.max(0, downloadLimit)
      uploadLimit = Math.max(0, uploadLimit)

      // Round to integer for storage (as the API expects integers)
      const roundedDownloadLimit = Math.round(downloadLimit)
      const roundedUploadLimit = Math.round(uploadLimit)

      await setDownloadSpeedLimit(roundedDownloadLimit)
      await setUploadSpeedLimit(roundedUploadLimit)

      // Show success message
      setSaveSuccess(true)

      // Reset success message after 3 seconds
      setTimeout(() => {
        setSaveSuccess(false)
      }, 3000)
    } catch (err) {
      console.error('Error saving speed limits:', err)
      setLocalError('Failed to save speed limits')
    }
  }

  const handleSelectFolder = async (): Promise<void> => {
    try {
      const selectedPath = await window.api.dialog.showDirectoryPicker()
      if (selectedPath) {
        setEditedDownloadPath(selectedPath)
      }
    } catch (err) {
      console.error('Error selecting folder:', err)
      setLocalError('Failed to select folder')
    }
  }

  const handleRefreshLocalStorage = async (): Promise<void> => {
    try {
      setLocalError(null)
      setSaveSuccess(false)
      
      // Trigger a refresh of the download service to scan for existing completed downloads
      // This will update the download queue with any local files found
      const result = await window.api.downloads.refreshLocalStorage()
      
      // Show success message with details
      const message = `Local storage refreshed successfully! Found ${result.added} new items and updated ${result.updated} existing items. Total: ${result.total} items.`
      setSaveSuccess(true)
      setRefreshResults(result)
      
      // Reset success message after 5 seconds (longer since there's more info)
      setTimeout(() => {
        setSaveSuccess(false)
        setRefreshResults(null)
      }, 5000)
    } catch (err) {
      console.error('Error refreshing local storage:', err)
      setLocalError('Failed to refresh local storage')
    }
  }

  // Handle unit conversion when dropdown changes
  const handleDownloadUnitChange = (newUnit: string): void => {
    if (!downloadSpeedInput.trim()) {
      // If input is empty, just change the unit
      setDownloadSpeedUnit(newUnit)
      return
    }

    const currentValue = parseFloat(downloadSpeedInput)
    if (isNaN(currentValue)) {
      // If current input is not a valid number, just change the unit
      setDownloadSpeedUnit(newUnit)
      return
    }

    const currentUnitValue = SPEED_UNITS.find((u) => u.value === downloadSpeedUnit)
    const newUnitValue = SPEED_UNITS.find((u) => u.value === newUnit)

    if (!currentUnitValue || !newUnitValue) {
      setDownloadSpeedUnit(newUnit)
      return
    }

    // If this is the first unit change, store the original KB/s value
    if (originalDownloadKbps.current === null) {
      if (downloadSpeedUnit === 'kbps') {
        originalDownloadKbps.current = currentValue
      } else {
        // Convert from current unit to KB/s
        originalDownloadKbps.current = currentValue * currentUnitValue.factor
      }
    }

    // Use the original KB/s value for conversions to prevent rounding errors
    if (originalDownloadKbps.current !== null) {
      const valueInNewUnit = originalDownloadKbps.current / newUnitValue.factor

      // Format based on the unit
      let formattedValue: string
      if (newUnit === 'mbps') {
        // For MB/s, show up to 2 decimal places, but trim trailing zeros
        formattedValue = valueInNewUnit.toFixed(2).replace(/\.?0+$/, '')
        if (formattedValue.endsWith('.')) formattedValue = formattedValue.slice(0, -1)
      } else {
        // For KB/s, show as integer
        formattedValue = Math.round(valueInNewUnit).toString()
      }

      setDownloadSpeedInput(formattedValue)
    }

    setDownloadSpeedUnit(newUnit)
  }

  const handleUploadUnitChange = (newUnit: string): void => {
    if (!uploadSpeedInput.trim()) {
      // If input is empty, just change the unit
      setUploadSpeedUnit(newUnit)
      return
    }

    const currentValue = parseFloat(uploadSpeedInput)
    if (isNaN(currentValue)) {
      // If current input is not a valid number, just change the unit
      setUploadSpeedUnit(newUnit)
      return
    }

    const currentUnitValue = SPEED_UNITS.find((u) => u.value === uploadSpeedUnit)
    const newUnitValue = SPEED_UNITS.find((u) => u.value === newUnit)

    if (!currentUnitValue || !newUnitValue) {
      setUploadSpeedUnit(newUnit)
      return
    }

    // If this is the first unit change, store the original KB/s value
    if (originalUploadKbps.current === null) {
      if (uploadSpeedUnit === 'kbps') {
        originalUploadKbps.current = currentValue
      } else {
        // Convert from current unit to KB/s
        originalUploadKbps.current = currentValue * currentUnitValue.factor
      }
    }

    // Use the original KB/s value for conversions to prevent rounding errors
    if (originalUploadKbps.current !== null) {
      const valueInNewUnit = originalUploadKbps.current / newUnitValue.factor

      // Format based on the unit
      let formattedValue: string
      if (newUnit === 'mbps') {
        // For MB/s, show up to 2 decimal places, but trim trailing zeros
        formattedValue = valueInNewUnit.toFixed(2).replace(/\.?0+$/, '')
        if (formattedValue.endsWith('.')) formattedValue = formattedValue.slice(0, -1)
      } else {
        // For KB/s, show as integer
        formattedValue = Math.round(valueInNewUnit).toString()
      }

      setUploadSpeedInput(formattedValue)
    }

    setUploadSpeedUnit(newUnit)
  }

  // Update stored KB/s value when input changes
  const handleDownloadInputChange = (value: string): void => {
    setDownloadSpeedInput(value.replace(/[^0-9.]/g, ''))

    // If the input is valid, update the original KB/s value
    const numValue = parseFloat(value)
    if (!isNaN(numValue)) {
      if (downloadSpeedUnit === 'kbps') {
        originalDownloadKbps.current = numValue
      } else {
        const factor = SPEED_UNITS.find((u) => u.value === downloadSpeedUnit)?.factor || 1
        originalDownloadKbps.current = numValue * factor
      }
    } else if (value.trim() === '') {
      originalDownloadKbps.current = null
    }
  }

  const handleUploadInputChange = (value: string): void => {
    setUploadSpeedInput(value.replace(/[^0-9.]/g, ''))

    // If the input is valid, update the original KB/s value
    const numValue = parseFloat(value)
    if (!isNaN(numValue)) {
      if (uploadSpeedUnit === 'kbps') {
        originalUploadKbps.current = numValue
      } else {
        const factor = SPEED_UNITS.find((u) => u.value === uploadSpeedUnit)?.factor || 1
        originalUploadKbps.current = numValue * factor
      }
    } else if (value.trim() === '') {
      originalUploadKbps.current = null
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.contentContainer}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM }}>
          <Title2 className={styles.headerTitle}>Application Settings</Title2>
          {isLoading && <Spinner size="large" label="Loading settings..." />}
        </div>
        <Text as="p" className={styles.headerSubtitle}>
          Configure application preferences and manage your downloads
        </Text>

        <LogUploadSettings />

        <Card className={styles.card}>
          <CardHeader description={<Subtitle1 weight="semibold">Download Settings</Subtitle1>} />
          <div className={styles.cardContent}>
            <Text>Set where your games will be downloaded and stored on your device</Text>

            <div className={styles.formRow}>
              <Input
                className={styles.input}
                value={editedDownloadPath}
                onChange={(_, data) => setEditedDownloadPath(data.value)}
                placeholder="Download path"
                contentAfter={
                  <Button
                    icon={<FolderOpenRegular />}
                    onClick={handleSelectFolder}
                    aria-label="Browse folders"
                  />
                }
                size="large"
              />
              <Button onClick={handleSaveDownloadPath} appearance="primary" size="large">
                Save Path
              </Button>
              <Button onClick={handleRefreshLocalStorage} appearance="outline" size="large">
                Refresh Local Storage
              </Button>
            </div>

            <div className={styles.speedLimitSection}>
              <Text>Configure download and upload speed limits</Text>

              <div className={styles.speedFormRow}>
                <div className={styles.speedControl}>
                  <Text>Download Speed Limit</Text>
                  <div className={styles.speedInputGroup}>
                    <Input
                      className={styles.speedInput}
                      value={downloadSpeedInput}
                      onChange={(_, data) => handleDownloadInputChange(data.value)}
                      placeholder="Unlimited"
                    />
                    <Dropdown
                      className={styles.unitDropdown}
                      value={SPEED_UNITS.find((u) => u.value === downloadSpeedUnit)?.label}
                      label="Download Speed Limit Unit"
                      selectedOptions={[downloadSpeedUnit]}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          handleDownloadUnitChange(data.optionValue)
                        }
                      }}
                      mountNode={document.getElementById('portal')}
                    >
                      {SPEED_UNITS.map((unit) => (
                        <Option key={unit.value} value={unit.value} text={unit.label}>
                          {unit.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>
                  <Text className={styles.hint}>
                    <InfoRegular />
                    Leave empty for unlimited download speed
                  </Text>
                </div>

                <div className={styles.speedControl}>
                  <Text>Upload Speed Limit</Text>
                  <div className={styles.speedInputGroup}>
                    <Input
                      className={styles.speedInput}
                      value={uploadSpeedInput}
                      onChange={(_, data) => handleUploadInputChange(data.value)}
                      placeholder="Unlimited"
                    />
                    <Dropdown
                      className={styles.unitDropdown}
                      value={SPEED_UNITS.find((u) => u.value === uploadSpeedUnit)?.label}
                      selectedOptions={[uploadSpeedUnit]}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          handleUploadUnitChange(data.optionValue)
                        }
                      }}
                      mountNode={document.getElementById('portal')}
                    >
                      {SPEED_UNITS.map((unit) => (
                        <Option key={unit.value} value={unit.value} text={unit.label}>
                          {unit.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </div>
                  <Text className={styles.hint}>
                    <InfoRegular />
                    Leave empty for unlimited upload speed
                  </Text>
                </div>
              </div>

              <div
                className={styles.formRow}
                style={{ justifyContent: 'flex-end', marginTop: tokens.spacingVerticalM }}
              >
                <Button onClick={handleSaveSpeedLimits} appearance="primary" size="large">
                  Save Speed Limits
                </Button>
              </div>
            </div>

            {(error || localError) && <Text className={styles.error}>{error || localError}</Text>}

            {saveSuccess && (
              <Text className={styles.success}>
                <CheckmarkCircleRegular />
                Settings saved successfully
              </Text>
            )}
            {refreshResults && (
              <Text className={styles.success}>
                <CheckmarkCircleRegular />
                Local storage refreshed successfully! Found {refreshResults.added} new items and updated {refreshResults.updated} existing items. Total: {refreshResults.total} items.
              </Text>
            )}
          </div>
        </Card>

        <BlacklistSettings />
      </div>
    </div>
  )
}

export default Settings
