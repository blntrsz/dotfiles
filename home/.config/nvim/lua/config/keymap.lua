local codediff = require("config.codediff")

vim.keymap.set("v", "J", ":m '>+1<CR>gv=gv")
vim.keymap.set("v", "K", ":m '<-2<CR>gv=gv")

vim.keymap.set("n", "<C-j>", "<cmd>cnext<CR>zz")
vim.keymap.set("n", "<C-k>", "<cmd>cprev<CR>zz")
vim.keymap.set("n", "<C-c>", "<cmd>cclose<CR>")
vim.keymap.set("n", "<leader>c", function()
  local filepath = vim.fn.expand("%:.")
  vim.fn.setreg("+", filepath)
  vim.notify("Copied filepath: " .. filepath)
end, { desc = "Copy relative filepath to clipboard" })
vim.keymap.set("n", "<leader>o", "<cmd>copen<CR>")

vim.keymap.set("v", ">", ">gv")
vim.keymap.set("v", "<", "<gv")

local function with_codediff(fn)
  local ok, lifecycle = pcall(require, "codediff.ui.lifecycle")
  if not ok then
    return
  end

  local tabpage = vim.api.nvim_get_current_tabpage()
  local session = lifecycle.get_session(tabpage)
  if not session then
    return
  end

  fn(lifecycle, session, tabpage)
end

local function codediff_open()
  local ok, lifecycle = pcall(require, "codediff.ui.lifecycle")
  if ok and lifecycle.get_session(vim.api.nvim_get_current_tabpage()) then
    return
  end

  vim.cmd("CodeDiff")
end

local function codediff_close()
  codediff.close()
end

local function codediff_refresh()
  with_codediff(function(lifecycle, session, tabpage)
    local panel = lifecycle.get_explorer(tabpage)
    if not panel then
      return
    end

    local ui = session.mode == "history" and require("codediff.ui.history") or require("codediff.ui.explorer")
    ui.refresh(panel)
  end)
end

local function codediff_toggle_panel()
  with_codediff(function(lifecycle, session, tabpage)
    local panel = lifecycle.get_explorer(tabpage)
    if not panel then
      return
    end

    local ui = session.mode == "history" and require("codediff.ui.history") or require("codediff.ui.explorer")
    ui.toggle_visibility(panel)
  end)
end

vim.keymap.set("n", "do", codediff_open)
vim.keymap.set("n", "dc", codediff_close)

vim.keymap.set("n", "<leader>/", function()
  require("config.multigrep").live_multi_grep()
end)

-- CodeDiff
vim.keymap.set("n", "<leader>dd", codediff_open)
vim.keymap.set("n", "<leader>dc", codediff_close)
vim.keymap.set("n", "<leader>dr", codediff_refresh)
vim.keymap.set("n", "<leader>de", codediff_toggle_panel)
