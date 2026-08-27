local M = {}

function M.close(tabpage)
  local ok, lifecycle = pcall(require, "codediff.ui.lifecycle")
  if not ok then
    return false
  end

  tabpage = tabpage or vim.api.nvim_get_current_tabpage()
  if not lifecycle.get_session(tabpage) then
    return false
  end

  if not lifecycle.confirm_close_with_unsaved(tabpage) then
    return true
  end

  if #vim.api.nvim_list_tabpages() == 1 then
    lifecycle.cleanup_for_quit(tabpage)
    vim.cmd("qall")
  else
    lifecycle.cleanup(tabpage)
    vim.cmd("tabclose")
  end

  return true
end

function M.map_quit(tabpage)
  if not vim.api.nvim_tabpage_is_valid(tabpage) then
    return
  end

  for _, winid in ipairs(vim.api.nvim_tabpage_list_wins(tabpage)) do
    local bufnr = vim.api.nvim_win_get_buf(winid)
    if vim.api.nvim_buf_is_valid(bufnr) then
      vim.keymap.set("n", "q", function()
        M.close(tabpage)
      end, { buffer = bufnr, desc = "Close codediff tab", nowait = true, silent = true })
    end
  end
end

return M
