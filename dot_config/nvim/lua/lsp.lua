local lspconfig = require("lspconfig")
local cmp = require("cmp")
local null_ls = require("null-ls")

local lsp = {
	sumneko_lua = {
		settings = {
			Lua = {
				diagnostics = {
					globals = {
						"vim",
					},
				},
			},
		},
	},
	tsserver = {
    root_dir = lspconfig.util.root_pattern("package.json"),
	},
	tailwindcss = {},
	cssls = {},
	astro = {},
	denols = {
    root_dir = lspconfig.util.root_pattern("deno.json"),
	},
}

cmp.setup({
	snippet = {
		expand = function(args)
			require("luasnip").lsp_expand(args.body)
		end,
	},
	mapping = cmp.mapping.preset.insert({
		["<C-k>"] = cmp.mapping.scroll_docs(-4),
		["<C-j>"] = cmp.mapping.scroll_docs(4),
		["<C-Space>"] = cmp.mapping.complete(),
		["<C-e>"] = cmp.mapping.abort(),
		["<CR>"] = cmp.mapping.confirm({ select = true }),
	}),
	sources = cmp.config.sources({
		{ name = "nvim_lsp" },
		{ name = "luasnip" },
	}, {
		{ name = "buffer" },
	}),
})

cmp.setup.filetype("gitcommit", {
	sources = cmp.config.sources({
		{ name = "cmp_git" },
	}, {
		{ name = "buffer" },
	}),
})

cmp.setup.cmdline({ "/", "?" }, {
	mapping = cmp.mapping.preset.cmdline(),
	sources = {
		{ name = "buffer" },
	},
})

cmp.setup.cmdline(":", {
	mapping = cmp.mapping.preset.cmdline(),
	sources = cmp.config.sources({
		{ name = "path" },
	}, {
		{ name = "cmdline" },
	}),
})

local on_attach = function(bufnr)
	require("lsp_signature").on_attach({}, bufnr)
end

local capabilities = require("cmp_nvim_lsp").default_capabilities(vim.lsp.protocol.make_client_capabilities())

for k, v in pairs(lsp) do
	lspconfig[k].setup({
		capabilities = capabilities,
		settings = v.settings,
		on_attach = on_attach,
	})
end

null_ls.setup({
	on_attach = function(client)
		if client.server_capabilities.documentFormattingProvider then
			-- format on save
			vim.cmd("autocmd BufWritePost * lua vim.lsp.buf.format({ async = true })")
		end
	end,
	sources = {
		null_ls.builtins.formatting.stylua,
		null_ls.builtins.code_actions.eslint_d,
		null_ls.builtins.formatting.prettierd,
		null_ls.builtins.completion.spell,
		null_ls.builtins.diagnostics.stylelint,
		null_ls.builtins.formatting.codespell,
		null_ls.builtins.code_actions.refactoring,
		null_ls.builtins.formatting.stylua,
		null_ls.builtins.diagnostics.selene,
	},
})
