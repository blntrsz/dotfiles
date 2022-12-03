vim.cmd [[colorscheme catppuccin]]
vim.g.catppuccin_flavour = "mocha"

-- Utils
local opt = vim.opt
local g = vim.g

local indent = 2

g.mapleader = " "
opt.clipboard = "unnamedplus"
opt.cursorline = true
opt.undofile = true

-- Numbers
opt.number = true
opt.relativenumber = true
opt.numberwidth = indent
opt.ruler = true
opt.tabstop = indent
opt.shiftwidth = indent
opt.scrolloff = 8

opt.completeopt = { "menu", "menuone", "noselect" }

vim.scriptencoding = 'utf-8'
opt.encoding = 'utf-8'
opt.fileencoding = 'utf-8'

opt.title = true
opt.autoindent = true
opt.smartindent = true
opt.hlsearch = true
opt.backup = false
opt.showcmd = true
opt.cmdheight = 1
opt.laststatus = 2
opt.expandtab = true
opt.shell = 'zsh'
opt.inccommand = 'split'
opt.ignorecase = true -- Case insensitive searching UNLESS /C or capital in search
opt.smarttab = true
opt.breakindent = true
opt.wrap = true
opt.backspace = { 'start', 'eol', 'indent' }
opt.path:append { '**' } -- Finding files - Search down into subfolders
opt.wildignore:append { '*/node_modules/*' }

-- Undercurl
vim.cmd([[let &t_Cs = "\e[4:3m"]])
vim.cmd([[let &t_Ce = "\e[4:0m"]])

-- Turn off paste mode when leaving insert
vim.api.nvim_create_autocmd("InsertLeave", {
  pattern = '*',
  command = "set nopaste"
})

-- Add asterisks in block comments
opt.formatoptions:append { 'r' }
