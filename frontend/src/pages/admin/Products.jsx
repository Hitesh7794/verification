import { useState } from 'react'
import AdminShell, { PageHead } from '../../components/shell/AdminShell.jsx'
import { AestheticCard, Icon } from '../../components/ui/extras.jsx'
import { FadeIn, StaggerList, StaggerItem } from '../../components/ui/motion.jsx'

import mfs500Img from '../../assets/products/mantra-mfs500.jpg'
import mis100v2Img from '../../assets/products/mantra-mis100v2.jpg'

// Verified hardware catalog for exam center administrators
const PRODUCTS = [
  {
    id: 'mantra-mfs500',
    name: 'Mantra MFS500 Biometric Fingerprint Scanner',
    category: 'fingerprint',
    categoryLabel: 'Fingerprint Scanner',
    tag: 'Fingerprint Scanner',
    image: mfs500Img,
    amazonUrl: 'https://www.amazon.in/MFS500-Biometric-Fingerprint-Scanner-Non-Aadhar/dp/B0GC7VMY6C',
    modelNumber: 'MFS500 (FAP10)',
    description: 'High-speed 500 DPI optical fingerprint reader designed for candidate biometric verification at examination centers.',
    highlights: [
      'STQC Certified & UIDAI Level-0 / Level-1 ready',
      '500 DPI optical sensor with scratch-resistant glass platen',
      'Built-in fake finger & active liveness detection',
      'Sub-second minutiae capture (< 500ms) with ISO 19794-2 standard output',
      'Plug-and-play USB connectivity for center operator laptops',
    ],
  },
  {
    id: 'mantra-mis100v2',
    name: 'Mantra MIS100V2 USB Single Iris Scanner',
    category: 'iris',
    categoryLabel: 'Iris Scanner',
    tag: 'Iris Scanner',
    image: mis100v2Img,
    amazonUrl: 'https://www.amazon.in/Mantra-MIS100V2-Scanner-Portable-Service/dp/B09RSHM8YQ/ref=sr_1_1?adgrpid=60270071438&dib=eyJ2IjoiMSJ9.QfB_M5_z86vJCzYS5hg6hKOo_9tzG86jg0APCgAgnxa3xvoqU81TSFZa3cVSUNDP1jB1ZzWEVwv_6mNyw0SiJJA5VVPDnFLf-cZUIxPpZP4OnHPrtoer6VGBc5rtoJEaliorvEgNZqCPlBwCdbYIWhAcTslR7DflE5AUUXQ3sIa5Vq3nh0owaglbhzeVj3jEe2ePMHhN_Q4CMAsIUw9Bqs75CCmLhj9ftlTE1jDYkY4.jkhtUUVutNwV2bK8ky9Rs9ex3MWlbOJQrYoKQ-DnQhA&dib_tag=se&gad_source=1&hvadid=590214941014&hvdev=c&hvexpln=0&hvlocphy=9303888&hvnetw=g&hvocijid=4556545584522511735--&hvqmt=b&hvrand=4556545584522511735&hvtargid=kwd-1333816882970&hydadcr=10367_2128952&keywords=mantra+mis100+v2+iris+scanner&mcid=fdc887212fc13b50a0dbac8d76aecc2f&qid=1787134079&sr=8-1',
    modelNumber: 'MIS100V2',
    description: 'High-precision optical iris capture device for secure and accurate biometric candidate verification.',
    highlights: [
      'STQC Certified for UIDAI & National Entrance Examinations',
      'Dual infrared LED illumination for clear capture in any lighting condition',
      'Scratch-proof optical prism with high ambient light rejection',
      'Fast auto-focus & optical distance indicator for seamless capture',
      'Standard USB interface compatible with examination workstations',
    ],
  },
]

export default function Products() {
  const [filter, setFilter] = useState('all')

  const filteredProducts = PRODUCTS.filter((item) => {
    if (filter === 'all') return true
    return item.category === filter
  })

  return (
    <AdminShell>
      <FadeIn>
        <PageHead
          eyebrow="Hardware"
          title="Certified Biometric Products"
          subtitle="Officially compatible biometric capture devices for center verification agent workstations."
        />

        {/* Filter Pills */}
        <div className="mb-6 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'all'
                ? 'bg-stone-900 text-white shadow-sm'
                : 'bg-white border border-stone-200/80 text-stone-600 hover:bg-stone-50 hover:text-stone-900'
            }`}
          >
            All Products ({PRODUCTS.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('fingerprint')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'fingerprint'
                ? 'bg-stone-900 text-white shadow-sm'
                : 'bg-white border border-stone-200/80 text-stone-600 hover:bg-stone-50 hover:text-stone-900'
            }`}
          >
            Fingerprint Scanners
          </button>
          <button
            type="button"
            onClick={() => setFilter('iris')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'iris'
                ? 'bg-stone-900 text-white shadow-sm'
                : 'bg-white border border-stone-200/80 text-stone-600 hover:bg-stone-50 hover:text-stone-900'
            }`}
          >
            Iris Scanners
          </button>
        </div>

        {/* Products Grid */}
        <StaggerList className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {filteredProducts.map((product) => (
            <StaggerItem key={product.id}>
              <AestheticCard className="group h-full flex flex-col justify-between p-6 hover:shadow-md transition-all">
                <div>
                  {/* Product Image Stage */}
                  <div className="mb-5 overflow-hidden rounded-2xl bg-stone-50/80 border border-stone-200/60 flex items-center justify-center h-52 relative">
                    <img
                      src={product.image}
                      alt={product.name}
                      className="max-h-44 w-auto object-contain transition-transform duration-300 group-hover:scale-105"
                      loading="lazy"
                    />
                    <div className="absolute top-3 left-3">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-semibold tracking-wide uppercase bg-white/90 backdrop-blur-sm border border-stone-200/70 text-stone-800 shadow-sm">
                        {product.tag}
                      </span>
                    </div>
                    <div className="absolute bottom-2.5 right-3">
                      <span className="text-[11px] font-mono text-stone-500 bg-white/80 backdrop-blur-sm px-2 py-0.5 rounded border border-stone-200/60">
                        {product.modelNumber}
                      </span>
                    </div>
                  </div>

                  {/* Product Name & Description */}
                  <h3 className="text-base font-semibold text-stone-900 mb-2 leading-snug">
                    {product.name}
                  </h3>
                  <p className="text-xs text-stone-600 mb-5 leading-relaxed">
                    {product.description}
                  </p>

                  {/* Key Specifications */}
                  <div className="space-y-2 mb-6">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                      Key Specifications
                    </p>
                    <ul className="space-y-2 text-xs text-stone-700">
                      {product.highlights.map((h, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <Icon.Check className="h-3.5 w-3.5 text-stone-900 mt-0.5 shrink-0" />
                          <span>{h}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Clean Buy on Amazon Button */}
                <div className="pt-4 border-t border-stone-100">
                  <a
                    href={product.amazonUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#FF9900] px-4 py-2.5 text-xs font-semibold text-stone-950 shadow-sm transition-all hover:bg-[#F28C00] hover:shadow active:scale-[0.99]"
                  >
                    <span>Buy on Amazon</span>
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
              </AestheticCard>
            </StaggerItem>
          ))}
        </StaggerList>
      </FadeIn>
    </AdminShell>
  )
}
