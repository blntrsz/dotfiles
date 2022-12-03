-- Utils
local function bind(mode, options)
	options = options or { noremap = true }

	return function(lhs, rhs, opts)
		opts = vim.tbl_extend("force", options, opts or {})

		vim.keymap.set(mode, lhs, rhs, opts)
	end
end

-- local nmap = bind("n", { noremap = false })
local nnoremap = bind("n")
local vnoremap = bind("v")
-- local xnoremap = bind("x")
-- local inoremap = bind("i")

-- Telescope
local builtin = require("telescope.builtin")

nnoremap("<C-p>", function()
	builtin.find_files()
end)

nnoremap("<leader>ff", function()
	builtin.find_files()
end)

nnoremap("<leader>fg", function()
	builtin.live_grep()
end)

nnoremap("<leader>fb", function()
	builtin.buffers()
end)

nnoremap("<leader>fh", function()
	builtin.help_tags()
end)

-- move commands

nnoremap("<C-j>", function()
	vim.cmd([[m .+1<CR>==]])
end)

nnoremap("<C-k>", function()
	vim.cmd([[m .-2<CR>==]])
end)

vnoremap("<C-j>", ":m '>+1<CR>==gv")
vnoremap("<C-k>", ":m '<-2<CR>==gv")

-- Horizontal shift

nnoremap(">", ">>")
nnoremap("<", "<<")

vnoremap(">", ">gv")
vnoremap("<", "<gv")

-- Netrw

nnoremap("<leader>r", function()
	if pcall(vim.cmd, "Rex") then
	else
		vim.cmd([[Ex]])
	end
end)

nnoremap("<leader>e", function()
	vim.cmd([[Ex]])
end)

-- Git

nnoremap("<leader>gs", function()
	require("neogit").open({ kind = "replace" })
end)

nnoremap("<leader>gh", function()
	vim.cmd([[Gitsigns preview_hunk]])
end)

nnoremap("<leader>gn", function()
	vim.cmd([[Gitsigns next_hunk]])
end)

nnoremap("<leader>gp", function()
	vim.cmd([[Gitsigns prev_hunk]])
end)

-- Harpoon
local harpoon_ui = require("harpoon.ui")

nnoremap("<leader>hh", function()
	require("harpoon.mark").add_file()
end)
nnoremap("<leader>ha", function()
	harpoon_ui.toggle_quick_menu()
end)

nnoremap("<leader>h1", function()
	harpoon_ui.nav_file(1)
end)
nnoremap("<leader>h2", function()
	harpoon_ui.nav_file(2)
end)
nnoremap("<leader>h3", function()
	harpoon_ui.nav_file(3)
end)
nnoremap("<leader>h4", function()
	harpoon_ui.nav_file(4)
end)

-- LSP

nnoremap("<leader>pp", function()
	vim.lsp.buf.format()
end)

-- Other

nnoremap("<leader>l", function()
	vim.cmd([[nohlsearch]])
end)

-- Lsp

nnoremap("gd", function()
	vim.cmd([[Lspsaga lsp_finder]])
end)

nnoremap("ga", function()
	vim.cmd([[Lspsaga code_action]])
end)

vnoremap("ga", function()
	vim.cmd([[Lspsaga code_action]])
end)

nnoremap("gr", function()
	vim.cmd([[Lspsaga rename]])
end)
nnoremap("gh", function()
	vim.cmd([[Lspsaga peek_definition]])
end)

nnoremap("cd", function()
	vim.cmd([[Lspsaga show_line_diagnostics]])
end)

nnoremap("<leader>cd", function()
	vim.cmd([[Lspsaga show_cursor_diagnostics]])
end)

nnoremap("[e", function()
	vim.cmd([[Lspsaga diagnostic_jump_prev]])
end)
nnoremap("]e", function()
	vim.cmd([[Lspsaga diagnostic_jump_next]])
end)

nnoremap("K", function()
	vim.cmd([[Lspsaga hover_doc]])
end)

-- Only jump to error
nnoremap("[E", function()
	require("lspsaga.diagnostic").goto_prev({ severity = vim.diagnostic.severity.ERROR })
end, { silent = true })
nnoremap("]E", function()
	require("lspsaga.diagnostic").goto_next({ severity = vim.diagnostic.severity.ERROR })
end, { silent = true })

-- Outline
nnoremap("<leader>o", function()
	vim.cmd([[LSoutlineToggle]])
end)

-- Float terminal
nnoremap("<A-d>", function()
	vim.cmd([[Lspsaga open_floaterm]])
end)
