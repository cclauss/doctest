// > ( log ('stdout') (1)
// . , setTimeout (log ('stdout'), 1, 2)
// . , log ('stderr') (3) )
// [stdout]: 1
// [stderr]: 3
// undefined
// [stdout]: 2
