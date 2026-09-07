export function missingProjectFolderMessage(folderPath: string): string {
	return `Mosayic couldn’t find your project folder at “${folderPath}”. It may have been deleted or moved. Restore it from Trash or Recycle Bin, or update the folder paths in Settings if you moved it, then try again.`;
}
